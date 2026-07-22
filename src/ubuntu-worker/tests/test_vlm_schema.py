"""Model output is data, not truth: nothing is stored until it validates."""

from __future__ import annotations

import json

import pytest

from app.schemas import ChunkMetrics, extract_json_text, parse_model_json
from app.vlm_runtime import SchemaViolation, coerce_metrics

VALID = {
    "concentration_score": 80,
    "concentration_level": "high",
    "presence": "present",
    "primary_activity": "writing",
    "phone_use": False,
    "away_from_desk": False,
    "posture_change_count": 2,
    "confidence": 0.7,
    "status_summary": "机に向かって筆記している。",
    "evidence_offsets_seconds": [1.9, 5.6],
}


def test_accepts_a_valid_response():
    metrics = coerce_metrics(json.dumps(VALID))
    assert metrics.concentration_score == 80
    assert metrics.primary_activity == "writing"


def test_accepts_a_fenced_response():
    metrics = coerce_metrics(f"```json\n{json.dumps(VALID)}\n```")
    assert metrics.concentration_level == "high"


def test_accepts_a_response_with_a_preamble():
    metrics = coerce_metrics(f"はい、分析結果です:\n{json.dumps(VALID)}")
    assert metrics.presence == "present"


def test_repairs_trailing_commas_and_python_literals():
    broken = (
        '{"concentration_score": 80, "concentration_level": "high", '
        '"presence": "present", "primary_activity": "writing", '
        '"phone_use": False, "away_from_desk": False, '
        '"posture_change_count": 2, "confidence": 0.7, '
        '"status_summary": "text", "evidence_offsets_seconds": [1.0,],}'
    )
    metrics = coerce_metrics(broken)
    assert metrics.phone_use is False


def test_out_of_range_values_are_clamped_not_rejected():
    payload = {**VALID, "concentration_score": 140, "confidence": 1.8}
    metrics = coerce_metrics(json.dumps(payload))
    assert metrics.concentration_score == 100
    assert metrics.confidence == 1.0


def test_unrecoverable_output_raises_rather_than_storing_garbage():
    with pytest.raises(SchemaViolation):
        coerce_metrics("集中していたと思います。JSONは出せません。")


def test_missing_required_field_is_a_violation():
    payload = {key: value for key, value in VALID.items() if key != "presence"}
    with pytest.raises(SchemaViolation):
        coerce_metrics(json.dumps(payload))


def test_invented_enum_value_is_rejected():
    # A hallucinated activity must not reach the UI as if it were observed.
    payload = {**VALID, "primary_activity": "daydreaming"}
    with pytest.raises(SchemaViolation):
        coerce_metrics(json.dumps(payload))


def test_summary_length_is_bounded():
    payload = {**VALID, "status_summary": "あ" * 5000}
    with pytest.raises(SchemaViolation):
        coerce_metrics(json.dumps(payload))


def test_extract_json_text_prefers_the_fenced_block():
    assert extract_json_text('noise ```json\n{"a": 1}\n``` more') == '{"a": 1}'


def test_parse_model_json_closes_a_truncated_object():
    # Hitting max_new_tokens mid-object is common; one repair pass recovers it.
    assert parse_model_json('{"a": 1, "b": 2') == {"a": 1, "b": 2}


def test_chunk_metrics_rejects_negative_posture_count():
    with pytest.raises(Exception):
        ChunkMetrics.model_validate({**VALID, "posture_change_count": -1})


def test_accepts_a_single_object_wrapped_in_an_array():
    # Gemma 3 sometimes wraps its answer in a list, which is a shape quirk
    # rather than a model failure.
    metrics = coerce_metrics(json.dumps([VALID]))
    assert metrics.concentration_score == 80


def test_accepts_a_fenced_array():
    metrics = coerce_metrics(f"```json\n{json.dumps([VALID])}\n```")
    assert metrics.presence == "present"


def test_rejects_a_multi_entry_array_rather_than_picking_one():
    # Silently taking the first entry would discard the model's other answers
    # and present a partial reading as if it were the whole chunk.
    with pytest.raises(SchemaViolation):
        coerce_metrics(json.dumps([VALID, VALID]))


def test_accepts_a_complete_object_followed_by_trailing_content():
    # A model that answers correctly and then keeps talking has still answered.
    # Observed from gemma-3-27b-it, which emitted the object then repeated it.
    noisy = json.dumps(VALID) + "\n" + json.dumps(VALID)
    metrics = coerce_metrics(noisy)
    assert metrics.concentration_score == 80


def test_accepts_an_object_followed_by_prose():
    metrics = coerce_metrics(json.dumps(VALID) + "\n\n以上が分析結果です。")
    assert metrics.presence == "present"
