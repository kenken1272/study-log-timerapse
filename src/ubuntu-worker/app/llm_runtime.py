"""llama.cpp aggregation model with a bounded OOM fallback ladder.

Run as a subprocess rather than an in-process binding so that VRAM is
unconditionally returned to the OS when the burst finishes — important because
the VLM needs its card back within seconds.

The requested model is Llama-3-70B-Instruct Q2_K. Whether it actually fits is
decided by measurement, never assumed; whatever ran is recorded in the output.
"""

from __future__ import annotations

import logging
import re
import subprocess
import time
from dataclasses import dataclass, replace
from pathlib import Path

from app import gpu_manager
from app.schemas import LlmRuntime as LlmRuntimeInfo
from app.schemas import parse_model_json

log = logging.getLogger(__name__)

# Substrings that mean "ran out of memory", not "gave a bad answer".
OOM_PATTERNS = (
    "out of memory",
    "cudaMalloc failed",
    "failed to allocate",
    "CUDA error: out of memory",
    "ggml_backend_cuda_buffer_type_alloc_buffer",
    "std::bad_alloc",
)


class LlmOom(Exception):
    pass


class LlmFailed(Exception):
    pass


@dataclass(frozen=True)
class LlmConfig:
    """One rung of the fallback ladder."""

    model_path: str
    display_name: str
    quantization: str
    context_size: int
    gpu_layers: int
    max_output_tokens: int = 1200
    batch_size: int = 512


@dataclass
class LlmOutput:
    payload: dict
    runtime: LlmRuntimeInfo


def looks_like_oom(stderr: str, returncode: int) -> bool:
    """Classify from the actual error text, not from a guess."""
    lowered = stderr.lower()
    if any(pattern.lower() in lowered for pattern in OOM_PATTERNS):
        return True
    # llama.cpp aborts on allocation failure; 134 = SIGABRT.
    return returncode in (-6, 134) and "alloc" in lowered


def build_fallback_ladder(primary: LlmConfig, alternates: list[LlmConfig]) -> list[LlmConfig]:
    """Primary, then the two documented degradations of it, then alternates.

    Bounded on purpose: at most one retry per rung, never an infinite loop.
    """
    ladder = [primary]
    if primary.context_size > 4096:
        ladder.append(replace(primary, context_size=4096))
    if primary.gpu_layers > 0:
        ladder.append(
            replace(
                primary,
                context_size=min(primary.context_size, 4096),
                gpu_layers=max(0, primary.gpu_layers // 2),
                batch_size=max(64, primary.batch_size // 2),
            )
        )
    ladder.extend(alternates)
    return ladder


class LlamaCppRuntime:
    def __init__(self, binary: str, gpu_index: int, timeout_sec: float = 1800.0) -> None:
        self._binary = binary
        self._gpu_index = gpu_index
        self._timeout = timeout_sec

    def _invoke(self, config: LlmConfig, prompt: str) -> tuple[str, int]:
        if not Path(config.model_path).exists():
            raise LlmFailed(f"model file not found: {config.model_path}")

        args = [
            self._binary,
            "-m", config.model_path,
            "-c", str(config.context_size),
            "-n", str(config.max_output_tokens),
            "-ngl", str(config.gpu_layers),
            "-b", str(config.batch_size),
            "--temp", "0.2",
            "--top-p", "0.9",
            "--no-display-prompt",
            "--no-warmup",
            "-no-cnv",
            "-p", prompt,
        ]
        env = {"CUDA_VISIBLE_DEVICES": str(self._gpu_index), "GGML_CUDA_NO_PINNED": "0"}

        started = time.perf_counter()
        process = gpu_manager.spawn_model_process(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**_inherited_env(), **env},
        )
        try:
            stdout, stderr = process.communicate(timeout=self._timeout)
        except subprocess.TimeoutExpired:
            gpu_manager.terminate_process_group(process)
            raise LlmFailed(f"llama.cpp exceeded {self._timeout:.0f}s") from None
        elapsed_ms = int((time.perf_counter() - started) * 1000)

        if process.returncode != 0:
            if looks_like_oom(stderr, process.returncode):
                raise LlmOom(stderr.strip()[-800:])
            raise LlmFailed(
                f"llama.cpp exited {process.returncode}: {stderr.strip()[-800:]}"
            )

        return stdout, elapsed_ms

    def generate(self, ladder: list[LlmConfig], prompt: str) -> LlmOutput:
        """Walk the ladder until a rung produces schema-valid JSON."""
        last_error: Exception | None = None
        fallback_reason: str | None = None

        for index, config in enumerate(ladder):
            is_fallback = index > 0
            try:
                log.info(
                    "LLM attempt %d/%d: %s ctx=%d ngl=%d",
                    index + 1, len(ladder), config.display_name,
                    config.context_size, config.gpu_layers,
                )
                stdout, elapsed_ms = self._invoke(config, prompt)
                payload = parse_model_json(stdout)
                return LlmOutput(
                    payload=payload,
                    runtime=LlmRuntimeInfo(
                        requested_model=ladder[0].display_name,
                        used_model=config.display_name,
                        quantization=config.quantization,
                        fallback_used=is_fallback,
                        fallback_reason=fallback_reason if is_fallback else None,
                        context_size=config.context_size,
                        inference_ms=elapsed_ms,
                        peak_vram_mib=gpu_manager.peak_vram_mib(self._gpu_index),
                    ),
                )
            except LlmOom as error:
                last_error = error
                fallback_reason = f"CUDA OOM on {config.display_name}: {str(error)[:200]}"
                log.warning("LLM OOM on %s; verifying VRAM released", config.display_name)
                _wait_for_vram_release(self._gpu_index)
            except LlmFailed as error:
                last_error = error
                fallback_reason = f"{config.display_name} failed: {str(error)[:200]}"
                log.warning("LLM failure on %s: %s", config.display_name, error)
            except Exception as error:
                last_error = error
                fallback_reason = f"{config.display_name} returned unusable JSON: {error}"
                log.warning("LLM output unparseable from %s: %s", config.display_name, error)

        raise LlmFailed(f"all {len(ladder)} LLM configurations failed: {last_error}")


def _inherited_env() -> dict:
    import os

    return dict(os.environ)


def _wait_for_vram_release(gpu_index: int, timeout: float = 60.0) -> None:
    """Confirm the dead process actually gave the memory back before retrying."""
    deadline = time.time() + timeout
    baseline = gpu_manager.memory_used_mib().get(gpu_index, 0)
    while time.time() < deadline:
        used = gpu_manager.memory_used_mib().get(gpu_index, 0)
        if used < 1024 or used < baseline / 2:
            log.info("GPU%d VRAM released (%dMiB in use)", gpu_index, used)
            return
        time.sleep(2)
    log.warning("GPU%d still reports %dMiB after %.0fs", gpu_index,
                gpu_manager.memory_used_mib().get(gpu_index, 0), timeout)


class MockLlmRuntime:
    """Deterministic stand-in for tests and WORKER_DRY_RUN."""

    def __init__(self, fail_times: int = 0) -> None:
        self._fail_times = fail_times
        self.calls = 0

    def generate(self, ladder: list[LlmConfig], prompt: str) -> LlmOutput:
        self.calls += 1
        index = min(self._fail_times, len(ladder) - 1)
        config = ladder[index]
        return LlmOutput(
            payload={
                "summary": "観察ログに基づく要約です。前半は着席が継続し、後半に離席が増えました。",
                "concentration": {
                    "average_score": 68.0,
                    "trend": "declining",
                    "high_periods": [],
                    "low_periods": [],
                },
                "observed_patterns": ["後半にスマートフォン操作の記録が増えた"],
                "bottlenecks": ["30分経過後の離席頻度の上昇"],
                "recommendations": [
                    {
                        "priority": 1,
                        "title": "25分ごとに区切る",
                        "reason": "後半に離席が集中していた",
                        "action": "次回は25分学習・5分休憩のタイマーを設定する",
                    }
                ],
                "data_quality": {"coverage_ratio": 0.9, "warnings": []},
            },
            runtime=LlmRuntimeInfo(
                requested_model=ladder[0].display_name,
                used_model=config.display_name,
                quantization=config.quantization,
                fallback_used=index > 0,
                fallback_reason="mock fallback" if index > 0 else None,
                context_size=config.context_size,
                inference_ms=1200,
                peak_vram_mib=0,
            ),
        )
