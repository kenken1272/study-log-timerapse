"""Llama-3.2-11B-Vision-Instruct at 4-bit, held resident on the VLM GPU.

The model is loaded once at service start and never unloaded during normal
operation — a per-chunk load would blow the 25s SLO on its own.

Compute dtype is float16, not bfloat16: the TITAN RTX is Turing (sm_75), which
has no native bf16 path.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app import gpu_manager
from app.schemas import ChunkMetrics, parse_model_json
from app.vlm_prompt import build_messages
from app.video_frames import ExtractedFrames

log = logging.getLogger(__name__)

QUANTIZATION = "4bit-nf4"


class SchemaViolation(Exception):
    """Model output could not be coerced into ChunkMetrics."""


@dataclass
class VlmResult:
    metrics: ChunkMetrics
    preprocess_ms: int
    generate_ms: int
    validate_ms: int
    peak_vram_mib: int


class VlmRuntime(Protocol):
    model_id: str
    quantization: str

    def warmup(self) -> None: ...
    def analyze(self, frames: ExtractedFrames) -> VlmResult: ...
    def unload(self) -> None: ...


class TransformersVlmRuntime:
    """Real implementation. Imports torch lazily so tests stay importable."""

    def __init__(self, model_id: str, gpu_index: int, revision: str | None = None,
                 max_new_tokens: int = 512) -> None:
        self.model_id = model_id
        self.quantization = QUANTIZATION
        self._gpu_index = gpu_index
        self._revision = revision
        self._max_new_tokens = max_new_tokens
        self._model = None
        self._processor = None

    def load(self) -> None:
        import torch
        from transformers import (
            AutoProcessor,
            BitsAndBytesConfig,
            MllamaForConditionalGeneration,
        )

        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            # Turing has no bf16; fp16 is the correct compute dtype here.
            bnb_4bit_compute_dtype=torch.float16,
        )
        kwargs = {"revision": self._revision} if self._revision else {}

        log.info("loading %s onto cuda:%d (4bit nf4)", self.model_id, self._gpu_index)
        started = time.perf_counter()
        self._model = MllamaForConditionalGeneration.from_pretrained(
            self.model_id,
            quantization_config=quant_config,
            device_map={"": self._gpu_index},
            torch_dtype=torch.float16,
            **kwargs,
        )
        self._processor = AutoProcessor.from_pretrained(self.model_id, **kwargs)
        self._model.eval()
        log.info("model loaded in %.1fs", time.perf_counter() - started)

    def warmup(self) -> None:
        """One throwaway generation so the first real chunk is not the outlier."""
        import torch
        from PIL import Image

        if self._model is None:
            self.load()

        blank = Image.new("RGB", (448, 448), color=(16, 16, 16))
        messages = build_messages([0.0], 30.0)
        prompt = self._processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = self._processor(images=[blank], text=prompt, return_tensors="pt").to(
            self._model.device
        )
        with torch.inference_mode():
            self._model.generate(**inputs, max_new_tokens=8, do_sample=False)
        torch.cuda.synchronize(self._gpu_index)
        log.info("VLM warmup complete")

    def analyze(self, frames: ExtractedFrames) -> VlmResult:
        import torch
        from PIL import Image

        if self._model is None:
            self.load()

        preprocess_started = time.perf_counter()
        images = [Image.open(path).convert("RGB") for path in frames.paths]
        messages = build_messages(frames.offsets_seconds, frames.duration_seconds)
        prompt = self._processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = self._processor(images=images, text=prompt, return_tensors="pt").to(
            self._model.device
        )
        torch.cuda.synchronize(self._gpu_index)
        preprocess_ms = int((time.perf_counter() - preprocess_started) * 1000)

        generate_started = time.perf_counter()
        with torch.inference_mode():
            output = self._model.generate(
                **inputs,
                max_new_tokens=self._max_new_tokens,
                do_sample=False,
                temperature=None,
                top_p=None,
            )
        torch.cuda.synchronize(self._gpu_index)
        generate_ms = int((time.perf_counter() - generate_started) * 1000)

        # Strip the echoed prompt; only the completion is parsed.
        generated = output[0][inputs["input_ids"].shape[-1]:]
        text = self._processor.decode(generated, skip_special_tokens=True)

        validate_started = time.perf_counter()
        metrics = coerce_metrics(text)
        validate_ms = int((time.perf_counter() - validate_started) * 1000)

        return VlmResult(
            metrics=metrics,
            preprocess_ms=preprocess_ms,
            generate_ms=generate_ms,
            validate_ms=validate_ms,
            peak_vram_mib=gpu_manager.peak_vram_mib(self._gpu_index),
        )

    def unload(self) -> None:
        """Release VRAM so the LLM can take the card (Mode B)."""
        import gc

        import torch

        self._model = None
        self._processor = None
        gc.collect()
        torch.cuda.empty_cache()
        log.info("VLM unloaded from cuda:%d", self._gpu_index)


def coerce_metrics(text: str) -> ChunkMetrics:
    """Parse and validate model output. One repair attempt, then give up.

    Raising here sends the chunk to RETRY_WAIT — a malformed response is never
    stored as a successful analysis.
    """
    try:
        payload = parse_model_json(text)
    except Exception as error:
        raise SchemaViolation(f"model did not return JSON: {error}") from error

    # Clamp the two fields models most often overshoot rather than failing the
    # whole chunk over a 101 or a 1.02.
    if isinstance(payload.get("concentration_score"), (int, float)):
        payload["concentration_score"] = int(
            max(0, min(100, payload["concentration_score"]))
        )
    if isinstance(payload.get("confidence"), (int, float)):
        payload["confidence"] = float(max(0.0, min(1.0, payload["confidence"])))

    try:
        return ChunkMetrics.model_validate(payload)
    except Exception as error:
        raise SchemaViolation(str(error)) from error


class MockVlmRuntime:
    """Deterministic stand-in used by the test suite and WORKER_DRY_RUN."""

    def __init__(self, model_id: str = "mock-vlm", latency_ms: int = 0) -> None:
        self.model_id = model_id
        self.quantization = "none"
        self._latency_ms = latency_ms

    def warmup(self) -> None:
        return None

    def analyze(self, frames: ExtractedFrames) -> VlmResult:
        if self._latency_ms:
            time.sleep(self._latency_ms / 1000)
        return VlmResult(
            metrics=ChunkMetrics(
                concentration_score=72,
                concentration_level="high",
                presence="present",
                primary_activity="writing",
                phone_use=False,
                away_from_desk=False,
                posture_change_count=1,
                confidence=0.6,
                status_summary="机に向かって筆記している様子が継続して観察された。",
                evidence_offsets_seconds=list(frames.offsets_seconds[:3]),
            ),
            preprocess_ms=10,
            generate_ms=self._latency_ms or 100,
            validate_ms=1,
            peak_vram_mib=0,
        )

    def unload(self) -> None:
        return None


def build_runtime(settings) -> VlmRuntime:
    if settings.dry_run:
        return MockVlmRuntime()
    return TransformersVlmRuntime(
        model_id=settings.vlm_model_id,
        gpu_index=settings.vlm_gpu,
        revision=settings.vlm_revision,
        max_new_tokens=settings.vlm_max_new_tokens,
    )
