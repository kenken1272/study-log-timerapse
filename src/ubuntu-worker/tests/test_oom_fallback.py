"""OOM handling: classified from real error text, bounded, and recorded."""

from __future__ import annotations

import pytest

from app.llm_runtime import (
    LlmConfig,
    LlmFailed,
    LlmOom,
    build_fallback_ladder,
    looks_like_oom,
)

PRIMARY = LlmConfig("/models/70b.gguf", "Meta-Llama-3-70B-Instruct-Q2_K", "Q2_K", 8192, 40)
QWEN = LlmConfig("/models/qwen.gguf", "Qwen2.5-32B-Instruct-Q4_K_M", "Q4_K_M", 8192, 40)
SMALL = LlmConfig("/models/8b.gguf", "Meta-Llama-3.1-8B-Instruct-Q6_K", "Q6_K", 8192, 99)


@pytest.mark.parametrize(
    "stderr",
    [
        "CUDA error: out of memory",
        "ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 8000 MiB",
        "cudaMalloc failed: out of memory",
        "terminate called after throwing an instance of 'std::bad_alloc'",
    ],
)
def test_recognises_real_oom_messages(stderr):
    assert looks_like_oom(stderr, 1) is True


@pytest.mark.parametrize(
    "stderr",
    [
        "error: failed to open model file",
        "unknown argument --nonsense",
        "the user asked about running out of time",
    ],
)
def test_does_not_guess_oom_from_unrelated_failures(stderr):
    # Misclassifying a config error as OOM would silently downgrade the model.
    assert looks_like_oom(stderr, 1) is False


def test_sigabrt_with_alloc_context_counts_as_oom():
    assert looks_like_oom("ggml alloc failure", 134) is True


def test_ladder_degrades_context_then_offload_then_alternates():
    ladder = build_fallback_ladder(PRIMARY, [QWEN, SMALL])
    assert ladder[0].context_size == 8192
    assert ladder[1].context_size == 4096
    assert ladder[2].gpu_layers < PRIMARY.gpu_layers
    assert ladder[-2].display_name == "Qwen2.5-32B-Instruct-Q4_K_M"
    assert ladder[-1].display_name == "Meta-Llama-3.1-8B-Instruct-Q6_K"


def test_ladder_is_finite():
    # The bound is what stops an OOM loop from running forever.
    ladder = build_fallback_ladder(PRIMARY, [QWEN, SMALL])
    assert len(ladder) == 5


def test_fallback_is_recorded_in_the_output(monkeypatch):
    from app.llm_runtime import LlamaCppRuntime

    runtime = LlamaCppRuntime("llama-cli", gpu_index=1)
    attempts = []

    def fake_invoke(config, prompt):
        attempts.append(config.display_name)
        if len(attempts) == 1:
            raise LlmOom("CUDA error: out of memory")
        return '{"summary": "ok"}', 1234

    monkeypatch.setattr(runtime, "_invoke", fake_invoke)
    monkeypatch.setattr("app.llm_runtime._wait_for_vram_release", lambda *a, **k: None)

    output = runtime.generate(build_fallback_ladder(PRIMARY, [QWEN]), "prompt")

    assert output.runtime.fallback_used is True
    assert "out of memory" in output.runtime.fallback_reason
    # requested_model always names what we asked for, used_model what ran.
    assert output.runtime.requested_model == "Meta-Llama-3-70B-Instruct-Q2_K"
    assert output.runtime.context_size == 4096
    assert len(attempts) == 2


def test_no_fallback_leaves_the_flag_clear(monkeypatch):
    from app.llm_runtime import LlamaCppRuntime

    runtime = LlamaCppRuntime("llama-cli", gpu_index=1)
    monkeypatch.setattr(runtime, "_invoke", lambda c, p: ('{"summary": "ok"}', 100))

    output = runtime.generate(build_fallback_ladder(PRIMARY, []), "prompt")
    assert output.runtime.fallback_used is False
    assert output.runtime.fallback_reason is None
    assert output.runtime.used_model == output.runtime.requested_model


def test_exhausting_every_rung_raises_rather_than_retrying_forever(monkeypatch):
    from app.llm_runtime import LlamaCppRuntime

    runtime = LlamaCppRuntime("llama-cli", gpu_index=1)
    calls = []

    def always_oom(config, prompt):
        calls.append(config.display_name)
        raise LlmOom("CUDA error: out of memory")

    monkeypatch.setattr(runtime, "_invoke", always_oom)
    monkeypatch.setattr("app.llm_runtime._wait_for_vram_release", lambda *a, **k: None)

    ladder = build_fallback_ladder(PRIMARY, [QWEN, SMALL])
    with pytest.raises(LlmFailed):
        runtime.generate(ladder, "prompt")
    assert len(calls) == len(ladder)


def test_missing_model_file_is_reported_not_treated_as_oom():
    runtime_config = LlmConfig("/does/not/exist.gguf", "ghost", "Q2_K", 8192, 20)
    from app.llm_runtime import LlamaCppRuntime

    runtime = LlamaCppRuntime("llama-cli", gpu_index=1)
    with pytest.raises(LlmFailed, match="model file not found"):
        runtime._invoke(runtime_config, "prompt")
