"""The per-chunk vision model, held resident at 4-bit on the VLM GPU.

The model is loaded once at service start and never unloaded during normal
operation — a per-chunk load would blow the 25s SLO on its own.

Compute dtype is float32 over 4-bit weights. The TITAN RTX is Turing (sm_75)
and has no bf16 path, and fp16 is not a usable substitute for Gemma 3: measured
here, fp16 gives NaN logits (absmax=nan) and the model emits only special
tokens, which decode to an empty string. fp32 keeps logits finite (absmax~66)
and produces valid JSON. Overridable with VLM_COMPUTE_DTYPE.

Two architectures are supported behind one interface so the same 30s chunk can
be scored by either and the results compared directly:

  * ``mllama``  — meta-llama/Llama-3.2-11B-Vision-Instruct (gated; pending)
  * ``gemma3``  — google/gemma-3-12b-it, google/gemma-3-4b-it

They differ only in how images reach the processor; the output schema, prompt
text and validation are shared, so switching model does not change what the UI
receives. Selected with VLM_MODEL_ID plus VLM_ARCHITECTURE=auto|gemma3|mllama.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app import gpu_manager
from app.schemas import ChunkMetrics, parse_model_json
from app.vlm_prompt import build_messages, build_messages_with_images
from app.video_frames import ExtractedFrames

log = logging.getLogger(__name__)

QUANTIZATION = "nf4-4bit"
# Measured on this host: Gemma 3 under fp16 yields NaN logits and empty output.
# fp32 compute over 4-bit weights is the working configuration.
DEFAULT_COMPUTE_DTYPE = "float32"


def resolve_dtype(name: str):
    """Map a dtype name to a torch dtype.

    bfloat16 is deliberately absent: this host is Turing (sm_75) and has no
    bf16 path, so accepting it would only fail later and less clearly.
    """
    import torch

    mapping = {"float16": torch.float16, "float32": torch.float32}
    if name not in mapping:
        raise SchemaViolation(
            f"unsupported compute dtype {name!r}; use float16 or float32"
        )
    return mapping[name]

ARCH_MLLAMA = "mllama"
ARCH_GEMMA3 = "gemma3"


def detect_architecture(model_id: str) -> str:
    """Infer the architecture from the model id.

    Kept deliberately dumb and overridable via VLM_ARCHITECTURE: guessing wrong
    fails loudly at load time rather than producing subtly wrong inputs.
    """
    lowered = model_id.lower()
    # "paligemma-3b" contains the substring "gemma-3" but is a different
    # architecture entirely, and is out of scope for this project.
    if "paligemma" in lowered:
        raise SchemaViolation(
            f"PaliGemma is not supported ({model_id!r}); use a Gemma 3 IT model"
        )
    if re.search(r"gemma-?3[-_]", lowered) or lowered.endswith("gemma-3"):
        return ARCH_GEMMA3
    if "llama-3.2" in lowered and "vision" in lowered:
        return ARCH_MLLAMA
    raise SchemaViolation(
        f"cannot infer architecture for {model_id!r}; set VLM_ARCHITECTURE explicitly"
    )


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
    compute_dtype: str

    def warmup(self) -> None: ...
    def analyze(self, frames: ExtractedFrames) -> VlmResult: ...
    def unload(self) -> None: ...


class TransformersVlmRuntime:
    """Real implementation. Imports torch lazily so tests stay importable."""

    def __init__(self, model_id: str, gpu_index: int, revision: str | None = None,
                 max_new_tokens: int = 512, architecture: str = "auto",
                 compute_dtype: str = DEFAULT_COMPUTE_DTYPE) -> None:
        self.model_id = model_id
        self.quantization = QUANTIZATION
        self.compute_dtype = compute_dtype
        self.architecture = (
            detect_architecture(model_id) if architecture == "auto" else architecture
        )
        self._gpu_index = gpu_index
        self._revision = revision
        self._max_new_tokens = max_new_tokens
        self._model = None
        self._processor = None

    def _model_class(self):
        from transformers import MllamaForConditionalGeneration

        if self.architecture == ARCH_GEMMA3:
            # Only importable on transformers >= 4.50; fail with a useful
            # message rather than an opaque ImportError.
            try:
                from transformers import Gemma3ForConditionalGeneration
            except ImportError as error:
                raise SchemaViolation(
                    "Gemma 3 needs transformers>=4.50; upgrade the venv"
                ) from error
            return Gemma3ForConditionalGeneration
        return MllamaForConditionalGeneration

    def load(self) -> None:
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig

        torch_dtype = resolve_dtype(self.compute_dtype)
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch_dtype,
        )
        kwargs = {"revision": self._revision} if self._revision else {}

        log.info(
            "loading %s (%s) onto cuda:%d (4bit nf4, %s compute)",
            self.model_id, self.architecture, self._gpu_index, self.compute_dtype,
        )
        started = time.perf_counter()
        self._model = self._model_class().from_pretrained(
            self.model_id,
            quantization_config=quant_config,
            device_map={"": self._gpu_index},
            torch_dtype=torch_dtype,
            **kwargs,
        )
        self._processor = AutoProcessor.from_pretrained(self.model_id, **kwargs)
        self._model.eval()
        self.load_seconds = time.perf_counter() - started
        log.info("model loaded in %.1fs", self.load_seconds)

    def _prepare_inputs(self, images: list, offsets: list[float], duration: float):
        """Build model inputs. The only genuinely architecture-specific step."""
        if self.architecture == ARCH_GEMMA3:
            # Gemma 3's template resolves inline images itself.
            messages = build_messages_with_images(images, offsets, duration)
            return self._processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            )

        messages = build_messages(offsets, duration)
        prompt = self._processor.apply_chat_template(messages, add_generation_prompt=True)
        return self._processor(images=images, text=prompt, return_tensors="pt")

    def warmup(self) -> None:
        """One throwaway generation so the first real chunk is not the outlier."""
        import torch
        from PIL import Image

        if self._model is None:
            self.load()

        blank = Image.new("RGB", (448, 448), color=(16, 16, 16))
        inputs = self._prepare_inputs([blank], [0.0], 30.0).to(self._model.device)
        with torch.inference_mode():
            self._model.generate(**inputs, max_new_tokens=8, do_sample=False)
        torch.cuda.synchronize(self._gpu_index)
        log.info("VLM warmup complete (%s)", self.model_id)

    def analyze(self, frames: ExtractedFrames) -> VlmResult:
        import torch
        from PIL import Image

        if self._model is None:
            self.load()

        preprocess_started = time.perf_counter()
        images = [Image.open(path).convert("RGB") for path in frames.paths]
        inputs = self._prepare_inputs(
            images, frames.offsets_seconds, frames.duration_seconds
        ).to(self._model.device)
        torch.cuda.synchronize(self._gpu_index)
        preprocess_ms = int((time.perf_counter() - preprocess_started) * 1000)

        prompt_length = inputs["input_ids"].shape[-1]

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
        generated = output[0][prompt_length:]
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
        self.compute_dtype = "none"
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
        architecture=settings.vlm_architecture,
        compute_dtype=settings.vlm_compute_dtype,
    )
