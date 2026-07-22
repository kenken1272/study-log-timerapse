"""Two VLM architectures, one output contract.

Gemma 3 is the interim model while Meta approval is pending. Swapping models
must not change what the pipeline or the UI receives, and must not silently
guess when the model id is unrecognised.
"""

from __future__ import annotations

import pytest

from app.vlm_prompt import build_messages, build_messages_with_images
from app.vlm_runtime import (
    ARCH_GEMMA3,
    ARCH_MLLAMA,
    SchemaViolation,
    detect_architecture,
)


@pytest.mark.parametrize(
    "model_id,expected",
    [
        ("google/gemma-3-12b-it", ARCH_GEMMA3),
        ("google/gemma-3-4b-it", ARCH_GEMMA3),
        ("google/gemma-3-27b-it", ARCH_GEMMA3),
        ("meta-llama/Llama-3.2-11B-Vision-Instruct", ARCH_MLLAMA),
        ("meta-llama/Llama-3.2-90B-Vision-Instruct", ARCH_MLLAMA),
    ],
)
def test_architecture_is_inferred_from_the_model_id(model_id, expected):
    assert detect_architecture(model_id) == expected


@pytest.mark.parametrize(
    "model_id",
    [
        "Qwen/Qwen2-VL-7B-Instruct",
        "some/unknown-model",
        "meta-llama/Llama-3.1-8B-Instruct",  # text-only, not a VLM
    ],
)
def test_unknown_models_fail_loudly_rather_than_guessing(model_id):
    # Guessing wrong would feed the model malformed inputs and produce
    # confident nonsense, which is worse than refusing to start.
    with pytest.raises(SchemaViolation, match="VLM_ARCHITECTURE"):
        detect_architecture(model_id)


@pytest.mark.parametrize(
    "model_id",
    ["google/paligemma-3b-mix-448", "google/paligemma2-10b-ft-docci-448"],
)
def test_paligemma_is_rejected_by_name(model_id):
    # "paligemma-3b" contains the substring "gemma-3", so a naive check routes
    # it to the Gemma 3 loader. PaliGemma is a different architecture and is
    # out of scope, so it must be refused rather than mis-loaded.
    with pytest.raises(SchemaViolation, match="PaliGemma is not supported"):
        detect_architecture(model_id)


def test_gemma_messages_carry_images_inline():
    images = ["<img0>", "<img1>", "<img2>"]
    messages = build_messages_with_images(images, [1.0, 2.0, 3.0], 30.0)

    user = messages[-1]["content"]
    embedded = [item for item in user if item["type"] == "image"]
    assert [item["image"] for item in embedded] == images
    # Chronological order must survive into the prompt.
    assert len(embedded) == 3


def test_mllama_messages_use_bare_placeholders():
    messages = build_messages([1.0, 2.0], 30.0)
    user = messages[-1]["content"]
    placeholders = [item for item in user if item["type"] == "image"]

    assert len(placeholders) == 2
    # Mllama's processor takes the images separately.
    assert all("image" not in item for item in placeholders)


def test_both_builders_produce_one_image_entry_per_frame():
    offsets = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    images = [f"<img{index}>" for index in offsets]

    bare = build_messages(offsets, 30.0)
    inline = build_messages_with_images(images, offsets, 30.0)

    for messages in (bare, inline):
        count = sum(1 for item in messages[-1]["content"] if item["type"] == "image")
        assert count == len(offsets)


def test_both_builders_share_the_same_instructions_and_schema():
    offsets = [1.0, 2.0]
    bare_text = build_messages(offsets, 30.0)[-1]["content"][-1]["text"]
    inline_text = build_messages_with_images(["a", "b"], offsets, 30.0)[-1]["content"][-1]["text"]

    # Identical task text means results from the two models are comparable.
    assert bare_text == inline_text
    assert "concentration_score" in bare_text
    assert "単一のJSONオブジェクトのみ" in bare_text


def test_system_prompt_forbids_identification_for_both():
    for messages in (
        build_messages([1.0], 30.0),
        build_messages_with_images(["a"], [1.0], 30.0),
    ):
        system = messages[0]["content"][0]["text"]
        assert "個人の識別" in system
        assert "感情の断定" in system


def test_frame_timestamps_appear_in_the_prompt():
    text = build_messages_with_images(["a", "b"], [1.88, 5.62], 30.0)[-1]["content"][-1]["text"]
    assert "1.88秒" in text
    assert "5.62秒" in text


@pytest.mark.parametrize("name", ["float16", "float32"])
def test_supported_compute_dtypes_resolve(name):
    pytest.importorskip("torch", reason="torch not installed")
    from app.vlm_runtime import resolve_dtype

    assert resolve_dtype(name) is not None


def test_bfloat16_is_rejected():
    # Turing (sm_75) has no bf16 path. Accepting it here would fail later and
    # far less clearly than refusing it up front.
    pytest.importorskip("torch", reason="torch not installed")
    from app.vlm_runtime import resolve_dtype

    with pytest.raises(SchemaViolation, match="float16 or float32"):
        resolve_dtype("bfloat16")


def test_default_compute_dtype_is_float32():
    # Gemma 3 produces NaN logits under fp16 on this hardware. If someone
    # "restores" fp16 as the default, this test is the tripwire.
    from app.llm_runtime import DEFAULT_COMPUTE_DTYPE as LLM_DEFAULT
    from app.vlm_runtime import DEFAULT_COMPUTE_DTYPE as VLM_DEFAULT

    assert VLM_DEFAULT == "float32"
    assert LLM_DEFAULT == "float32"
