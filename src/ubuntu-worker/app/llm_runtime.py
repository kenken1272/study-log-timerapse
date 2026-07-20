"""The 30-minute / final aggregation model: Gemma 3 27B at 4-bit on the LLM GPU.

Runs through Transformers rather than llama.cpp, matching the VLM, so both
models share one dependency stack, one quantization path and one dtype policy.

Loaded on demand and unloaded as soon as the burst finishes: the VLM needs its
own card back within seconds, and holding 20GB idle on GPU1 buys nothing.

Compute dtype is float32 over 4-bit weights. Gemma 3 is natively bf16, and this
host is Turing (sm_75) with no bf16 path — but fp16 is not a usable substitute:
measured on this machine, Gemma 3 under fp16 produces NaN logits and generates
nothing but special tokens. fp32 compute is the configuration that works.
"""

from __future__ import annotations

import gc
import logging
import time
from dataclasses import dataclass, replace

from app import gpu_manager
from app.schemas import LlmRuntime as LlmRuntimeInfo
from app.schemas import parse_model_json

log = logging.getLogger(__name__)

QUANTIZATION = "nf4-4bit"
# Gemma 3 produces NaN logits under fp16 on this hardware (measured: absmax=nan,
# empty output). fp32 compute over 4-bit weights is the working configuration.
DEFAULT_COMPUTE_DTYPE = "float32"


class LlmOom(Exception):
    """Ran out of memory, as opposed to giving a bad answer."""


class LlmFailed(Exception):
    pass


@dataclass(frozen=True)
class LlmConfig:
    """One rung of the fallback ladder."""

    model_id: str
    display_name: str
    quantization: str = QUANTIZATION
    context_size: int = 8192
    max_output_tokens: int = 1200
    # Transformers generates one sequence at a time here, so "batch size" is
    # not a real knob. The memory it would have controlled is the KV cache,
    # which context_size and max_output_tokens govern instead.
    cpu_offload: bool = False


@dataclass
class LlmOutput:
    payload: dict
    runtime: LlmRuntimeInfo


def is_oom(error: BaseException) -> bool:
    """Classify from the exception itself rather than guessing from a string."""
    name = type(error).__name__
    if name in ("OutOfMemoryError", "CudaOutOfMemoryError"):
        return True
    text = str(error).lower()
    return "out of memory" in text or "cuda oom" in text


def build_fallback_ladder(
    primary: LlmConfig, alternates: list[LlmConfig] | None = None
) -> list[LlmConfig]:
    """Primary, then its documented degradations, then smaller models.

    Bounded on purpose: each rung is attempted at most once, so an OOM loop
    cannot run forever.
    """
    ladder = [primary]
    if primary.context_size > 4096:
        ladder.append(replace(primary, context_size=4096))
    if not primary.cpu_offload:
        ladder.append(
            replace(
                primary,
                context_size=min(primary.context_size, 4096),
                cpu_offload=True,
            )
        )
    ladder.extend(alternates or [])
    return ladder


class TransformersLlmRuntime:
    """Loads, generates, and unloads. Never stays resident between bursts."""

    def __init__(self, gpu_index: int, revision: str | None = None,
                 compute_dtype: str = DEFAULT_COMPUTE_DTYPE) -> None:
        self._gpu_index = gpu_index
        self._revision = revision
        self.compute_dtype = compute_dtype
        self._model = None
        self._processor = None
        self._loaded_config: LlmConfig | None = None
        self.last_load_ms = 0
        self.last_prompt_tokens = 0
        self.last_output_tokens = 0

    # ------------------------------------------------------------------

    def _load(self, config: LlmConfig) -> None:
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig, Gemma3ForConditionalGeneration

        from app.vlm_runtime import resolve_dtype

        torch_dtype = resolve_dtype(self.compute_dtype)
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch_dtype,
        )
        kwargs = {"revision": self._revision} if self._revision else {}

        if config.cpu_offload:
            # Spill whatever will not fit into the host's ~125GiB of RAM rather
            # than forcing the whole model onto one 24GB card.
            free_mib = gpu_manager.memory_free_mib(self._gpu_index)
            budget = max(4, int(free_mib / 1024) - 3)
            device_map = "auto"
            max_memory = {self._gpu_index: f"{budget}GiB", "cpu": "80GiB"}
            log.info("loading %s with CPU offload (GPU budget %dGiB)",
                     config.model_id, budget)
        else:
            device_map = {"": self._gpu_index}
            max_memory = None
            log.info("loading %s onto cuda:%d (4bit nf4, %s compute)",
                     config.model_id, self._gpu_index, self.compute_dtype)

        started = time.perf_counter()
        self._model = Gemma3ForConditionalGeneration.from_pretrained(
            config.model_id,
            quantization_config=quant_config,
            device_map=device_map,
            max_memory=max_memory,
            torch_dtype=torch_dtype,
            **kwargs,
        )
        self._processor = AutoProcessor.from_pretrained(config.model_id, **kwargs)
        self._model.eval()
        self.last_load_ms = int((time.perf_counter() - started) * 1000)
        self._loaded_config = config
        log.info("aggregation model loaded in %dms", self.last_load_ms)

    def unload(self) -> None:
        """Return VRAM to the OS so the VLM can have its card back."""
        if self._model is None:
            return
        import torch

        self._model = None
        self._processor = None
        self._loaded_config = None
        gc.collect()
        torch.cuda.empty_cache()
        log.info("aggregation model unloaded from cuda:%d", self._gpu_index)

    # ------------------------------------------------------------------

    def _generate_once(self, config: LlmConfig, prompt: str) -> tuple[str, int]:
        import torch

        self._load(config)

        messages = [
            {"role": "user", "content": [{"type": "text", "text": prompt}]},
        ]
        inputs = self._processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
            # Bound the KV cache. Gemma 3 supports 128K, but nothing here needs
            # it and the memory cost is real.
            truncation=True,
            max_length=config.context_size,
        ).to(self._model.device)

        prompt_tokens = int(inputs["input_ids"].shape[-1])
        self.last_prompt_tokens = prompt_tokens

        started = time.perf_counter()
        with torch.inference_mode():
            output = self._model.generate(
                **inputs,
                max_new_tokens=config.max_output_tokens,
                do_sample=False,
                temperature=None,
                top_p=None,
            )
        torch.cuda.synchronize(self._gpu_index)
        inference_ms = int((time.perf_counter() - started) * 1000)

        generated = output[0][prompt_tokens:]
        self.last_output_tokens = int(generated.shape[-1])
        text = self._processor.decode(generated, skip_special_tokens=True)
        return text, inference_ms

    def generate(self, ladder: list[LlmConfig], prompt: str) -> LlmOutput:
        """Walk the ladder until a rung produces parseable JSON."""
        last_error: Exception | None = None
        fallback_reason: str | None = None

        for index, config in enumerate(ladder):
            is_fallback = index > 0
            try:
                log.info(
                    "LLM attempt %d/%d: %s ctx=%d offload=%s",
                    index + 1, len(ladder), config.display_name,
                    config.context_size, config.cpu_offload,
                )
                peak_before = gpu_manager.peak_vram_mib(self._gpu_index)
                text, inference_ms = self._generate_once(config, prompt)
                peak = max(peak_before, gpu_manager.peak_vram_mib(self._gpu_index))
                payload = parse_model_json(text)

                return LlmOutput(
                    payload=payload,
                    runtime=LlmRuntimeInfo(
                        requested_model=ladder[0].display_name,
                        used_model=config.display_name,
                        quantization=config.quantization,
                        compute_dtype=self.compute_dtype,
                        fallback_used=is_fallback,
                        fallback_reason=fallback_reason if is_fallback else None,
                        context_size=config.context_size,
                        prompt_tokens=self.last_prompt_tokens,
                        output_tokens=self.last_output_tokens,
                        model_load_ms=self.last_load_ms,
                        inference_ms=inference_ms,
                        peak_vram_mib=peak,
                    ),
                )
            except Exception as error:
                last_error = error
                if is_oom(error):
                    fallback_reason = (
                        f"CUDA OOM on {config.display_name} "
                        f"(ctx={config.context_size}, offload={config.cpu_offload})"
                    )
                    log.warning("LLM OOM on %s; releasing VRAM before next rung",
                                config.display_name)
                else:
                    fallback_reason = f"{config.display_name} failed: {str(error)[:200]}"
                    log.warning("LLM failure on %s: %s", config.display_name, error)
            finally:
                # Always release, whether the rung succeeded, OOMed or crashed.
                self.unload()
                _wait_for_vram_release(self._gpu_index)

        raise LlmFailed(f"all {len(ladder)} LLM configurations failed: {last_error}")


def _wait_for_vram_release(gpu_index: int, timeout: float = 60.0) -> None:
    """Confirm the memory actually came back before trying the next rung."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        used = gpu_manager.memory_used_mib().get(gpu_index, 0)
        if used < 1024:
            return
        time.sleep(2)
    log.warning(
        "GPU%d still reports %dMiB after %.0fs",
        gpu_index, gpu_manager.memory_used_mib().get(gpu_index, 0), timeout,
    )


class MockLlmRuntime:
    """Deterministic stand-in for tests and WORKER_DRY_RUN."""

    def __init__(self, fail_times: int = 0) -> None:
        self._fail_times = fail_times
        self.calls = 0

    def unload(self) -> None:
        return None

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
                # Never claim the real model ran. A dry-run report must be
                # distinguishable from a genuine one at a glance.
                used_model=f"mock-llm ({config.display_name})",
                quantization="none",
                compute_dtype="none",
                fallback_used=index > 0,
                fallback_reason="mock fallback" if index > 0 else None,
                context_size=config.context_size,
                prompt_tokens=0,
                output_tokens=0,
                model_load_ms=0,
                inference_ms=1200,
                peak_vram_mib=0,
            ),
        )
