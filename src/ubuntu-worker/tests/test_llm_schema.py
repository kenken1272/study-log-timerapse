"""The aggregate report is rendered in the UI, so its shape is enforced here."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import aggregator
from app.llm_prompt import build_prompt, compact_chunk_rows
from app.llm_runtime import LlmConfig, LlmFailed, MockLlmRuntime
from app.schemas import AggregateAnalysis

LADDER = [LlmConfig("/models/primary.gguf", "Meta-Llama-3-70B-Instruct-Q2_K", "Q2_K", 8192, 20)]


def make_plan(chunk_count: int = 60, minutes: int = 30) -> aggregator.WindowPlan:
    start = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)
    return aggregator.WindowPlan(
        session_id="sess-1",
        uid="user-1",
        analysis_type="window",
        start=start,
        end=start + timedelta(minutes=minutes),
        rows=[],
        aggregation_key="sess-1|window|x",
    )


def make_payloads(count: int) -> list[dict]:
    return [
        {
            "chunk_started_at": f"2026-07-20T10:{index // 2:02d}:{(index % 2) * 30:02d}Z",
            "segment_index": 0,
            "chunk_index": index,
            "metrics": {
                "concentration_score": 70,
                "concentration_level": "high",
                "presence": "present",
                "primary_activity": "writing",
                "phone_use": False,
                "away_from_desk": False,
                "confidence": 0.6,
                "status_summary": "筆記中",
            },
        }
        for index in range(count)
    ]


def test_produces_a_valid_report():
    analysis = aggregator.build_analysis(make_plan(), make_payloads(60), MockLlmRuntime(), LADDER)
    assert isinstance(analysis, AggregateAnalysis)
    assert analysis.session_id == "sess-1"
    assert analysis.runtime.requested_model == "Meta-Llama-3-70B-Instruct-Q2_K"


def test_coverage_is_computed_locally_not_taken_from_the_model():
    # The model is not trusted to report how complete its own input was.
    analysis = aggregator.build_analysis(make_plan(), make_payloads(30), MockLlmRuntime(), LADDER)
    assert analysis.data_quality.coverage_ratio == pytest.approx(0.5)
    assert analysis.window.missing_chunk_count == 30


def test_missing_chunks_produce_a_visible_warning():
    analysis = aggregator.build_analysis(make_plan(), make_payloads(20), MockLlmRuntime(), LADDER)
    assert any("欠損" in warning for warning in analysis.data_quality.warnings)


def test_full_coverage_adds_no_gap_warning():
    analysis = aggregator.build_analysis(make_plan(), make_payloads(60), MockLlmRuntime(), LADDER)
    assert analysis.data_quality.coverage_ratio == 1.0
    assert not any("欠損" in warning for warning in analysis.data_quality.warnings)


def test_malformed_recommendations_are_dropped_not_fatal():
    class PartlyBadLlm(MockLlmRuntime):
        def generate(self, ladder, prompt):
            output = super().generate(ladder, prompt)
            output.payload["recommendations"] = [
                {"priority": 1, "title": "ok", "reason": "r", "action": "a"},
                {"nonsense": True},
                "not even an object",
            ]
            return output

    analysis = aggregator.build_analysis(make_plan(), make_payloads(60), PartlyBadLlm(), LADDER)
    assert len(analysis.recommendations) == 1
    assert analysis.recommendations[0].title == "ok"


def test_invalid_concentration_block_fails_the_report():
    class BadLlm(MockLlmRuntime):
        def generate(self, ladder, prompt):
            output = super().generate(ladder, prompt)
            output.payload["concentration"] = {"average_score": 900, "trend": "sideways"}
            return output

    with pytest.raises(LlmFailed):
        aggregator.build_analysis(make_plan(), make_payloads(60), BadLlm(), LADDER)


def test_prompt_omits_runtime_metadata():
    payloads = make_payloads(3)
    for payload in payloads:
        payload["runtime"] = {"model": "secret-model", "peak_vram_mib": 12000}

    prompt = build_prompt("sess-1", "window", "start", "end", payloads, 0, 60)
    assert "secret-model" not in prompt
    assert "peak_vram_mib" not in prompt


def test_prompt_states_the_no_fabrication_rules():
    prompt = build_prompt("sess-1", "final", "start", "end", make_payloads(2), 0, 60)
    assert "作り出さない" in prompt
    assert "推測で埋めない" in prompt
    assert "診断" in prompt


def test_compact_rows_keep_the_timeline_fields():
    compact = compact_chunk_rows(make_payloads(2))
    assert compact[0]["score"] == 70
    assert compact[0]["activity"] == "writing"
    assert "t" in compact[0]
