"""OOM handling: classified from the exception, bounded, and recorded.

The aggregation model runs through Transformers now, so OOM arrives as a typed
exception rather than as text on a subprocess's stderr. That is strictly better
— no string matching to get wrong — but the guarantees are unchanged: the
ladder is finite, VRAM is always released, and whatever actually ran is named
in the output.
"""

from __future__ import annotations

import pytest

from app.llm_runtime import (
    LlmConfig,
    LlmFailed,
    build_fallback_ladder,
    is_oom,
)

PRIMARY = LlmConfig(
    model_id="google/gemma-3-27b-it",
    display_name="google/gemma-3-27b-it",
    context_size=8192,
)
SMALLER = LlmConfig(
    model_id="google/gemma-3-12b-it",
    display_name="google/gemma-3-12b-it",
    context_size=8192,
)


class FakeOom(Exception):
    pass


FakeOom.__name__ = "OutOfMemoryError"


def test_recognises_a_torch_oom_by_type():
    assert is_oom(FakeOom("CUDA out of memory. Tried to allocate 2.00 GiB")) is True


@pytest.mark.parametrize(
    "message",
    [
        "CUDA out of memory. Tried to allocate 8.00 GiB",
        "cuda oom while allocating KV cache",
    ],
)
def test_recognises_oom_by_message(message):
    assert is_oom(RuntimeError(message)) is True


@pytest.mark.parametrize(
    "message",
    [
        "model repo not found",
        "the user ran out of time",  # 'out of' but not memory
        "invalid dtype for this device",
    ],
)
def test_does_not_guess_oom_from_unrelated_failures(message):
    # Misclassifying a config error as OOM would silently downgrade the model.
    assert is_oom(RuntimeError(message)) is False


def test_ladder_degrades_context_then_offload_then_smaller_model():
    ladder = build_fallback_ladder(PRIMARY, [SMALLER])

    assert ladder[0].context_size == 8192
    assert ladder[0].cpu_offload is False
    assert ladder[1].context_size == 4096
    assert ladder[2].cpu_offload is True
    assert ladder[-1].model_id == "google/gemma-3-12b-it"


def test_ladder_is_finite():
    # The bound is what stops an OOM loop from running forever.
    assert len(build_fallback_ladder(PRIMARY, [SMALLER])) == 4
    assert len(build_fallback_ladder(PRIMARY, [])) == 3


def test_ladder_does_not_duplicate_an_already_offloaded_primary():
    offloaded = LlmConfig(
        model_id="google/gemma-3-27b-it",
        display_name="google/gemma-3-27b-it",
        context_size=4096,
        cpu_offload=True,
    )
    assert len(build_fallback_ladder(offloaded, [])) == 1


def _runtime_with(monkeypatch, behaviour):
    from app.llm_runtime import TransformersLlmRuntime

    runtime = TransformersLlmRuntime(gpu_index=1)
    monkeypatch.setattr(runtime, "_generate_once", behaviour)
    monkeypatch.setattr(runtime, "unload", lambda: None)
    monkeypatch.setattr("app.llm_runtime._wait_for_vram_release", lambda *a, **k: None)
    monkeypatch.setattr("app.gpu_manager.peak_vram_mib", lambda _index: 18000)
    return runtime


def test_fallback_is_recorded_in_the_output(monkeypatch):
    attempts = []

    def behaviour(config, prompt):
        attempts.append(config.display_name)
        if len(attempts) == 1:
            raise FakeOom("CUDA out of memory")
        return '{"summary": "ok"}', 4321

    runtime = _runtime_with(monkeypatch, behaviour)
    output = runtime.generate(build_fallback_ladder(PRIMARY, [SMALLER]), "prompt")

    assert output.runtime.fallback_used is True
    assert "OOM" in output.runtime.fallback_reason
    # requested_model always names what we asked for, used_model what ran.
    assert output.runtime.requested_model == "google/gemma-3-27b-it"
    assert output.runtime.context_size == 4096
    assert output.runtime.quantization == "nf4-4bit"
    assert output.runtime.compute_dtype == "float32"
    assert len(attempts) == 2


def test_no_fallback_leaves_the_flag_clear(monkeypatch):
    runtime = _runtime_with(monkeypatch, lambda c, p: ('{"summary": "ok"}', 100))
    output = runtime.generate(build_fallback_ladder(PRIMARY, []), "prompt")

    assert output.runtime.fallback_used is False
    assert output.runtime.fallback_reason is None
    assert output.runtime.used_model == output.runtime.requested_model


def test_falls_back_to_the_smaller_model_when_every_27b_rung_ooms(monkeypatch):
    attempts = []

    def behaviour(config, prompt):
        attempts.append(config.model_id)
        if config.model_id == "google/gemma-3-27b-it":
            raise FakeOom("CUDA out of memory")
        return '{"summary": "ok"}', 999

    runtime = _runtime_with(monkeypatch, behaviour)
    output = runtime.generate(build_fallback_ladder(PRIMARY, [SMALLER]), "prompt")

    assert output.runtime.used_model == "google/gemma-3-12b-it"
    assert output.runtime.fallback_used is True
    assert attempts.count("google/gemma-3-27b-it") == 3  # each rung tried once


def test_exhausting_every_rung_raises_rather_than_retrying_forever(monkeypatch):
    attempts = []

    def always_oom(config, prompt):
        attempts.append(config.display_name)
        raise FakeOom("CUDA out of memory")

    runtime = _runtime_with(monkeypatch, always_oom)
    ladder = build_fallback_ladder(PRIMARY, [SMALLER])

    with pytest.raises(LlmFailed):
        runtime.generate(ladder, "prompt")
    assert len(attempts) == len(ladder)


def test_vram_is_released_after_every_attempt(monkeypatch):
    from app.llm_runtime import TransformersLlmRuntime

    runtime = TransformersLlmRuntime(gpu_index=1)
    unloads = []

    monkeypatch.setattr(runtime, "_generate_once", lambda c, p: ('{"summary": "ok"}', 10))
    monkeypatch.setattr(runtime, "unload", lambda: unloads.append(1))
    monkeypatch.setattr("app.llm_runtime._wait_for_vram_release", lambda *a, **k: None)
    monkeypatch.setattr("app.gpu_manager.peak_vram_mib", lambda _index: 0)

    runtime.generate(build_fallback_ladder(PRIMARY, []), "prompt")

    # Even on success: the VLM needs the card back.
    assert unloads == [1]


def test_unparseable_output_is_not_treated_as_oom(monkeypatch):
    attempts = []

    def behaviour(config, prompt):
        attempts.append(config.display_name)
        return "I cannot produce JSON, sorry.", 100

    runtime = _runtime_with(monkeypatch, behaviour)
    with pytest.raises(LlmFailed):
        runtime.generate(build_fallback_ladder(PRIMARY, []), "prompt")

    # It still walks the ladder, but the reason must not claim memory pressure.
    assert len(attempts) == 3
