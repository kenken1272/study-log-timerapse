"""30-minute window and end-of-session aggregation.

Windows are event-time based, anchored on the first not-yet-aggregated chunk.
Counting to 60 would be wrong: breaks, segment splits, re-sends and dropped
uploads all make the chunk count an unreliable proxy for elapsed time.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Sequence

from app import result_store
from app.llm_prompt import build_prompt
from app.llm_runtime import LlmConfig, LlmFailed
from app.queue_db import QueueDB, final_key, window_key
from app.schemas import (
    AggregateAnalysis,
    AnalysisWindow,
    Concentration,
    DataQuality,
    utc_now_iso,
)

log = logging.getLogger(__name__)

CHUNK_SECONDS = 30


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        text = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def chunk_event_time(row: sqlite3.Row | dict) -> datetime | None:
    """Best available event time for a chunk.

    GCS timeCreated is upload time, which for a live recording trails the real
    capture time by roughly one chunk. That offset is uniform, so window
    boundaries stay meaningful; it is recorded rather than silently corrected.
    """
    value = row["gcs_time_created"] if "gcs_time_created" in row.keys() else None
    parsed = parse_iso(value)
    if parsed is not None:
        return parsed
    created = row["created_at"] if "created_at" in row.keys() else None
    if isinstance(created, (int, float)):
        return datetime.fromtimestamp(created, tz=timezone.utc)
    return None


@dataclass
class WindowPlan:
    session_id: str
    uid: str
    analysis_type: str
    start: datetime
    end: datetime
    rows: list[sqlite3.Row]
    aggregation_key: str


def expected_chunk_count(start: datetime, end: datetime) -> int:
    """Theoretical maximum for the span — 60 for 30 minutes, not a hard target."""
    return max(1, int((end - start).total_seconds() // CHUNK_SECONDS))


def plan_windows(
    db: QueueDB,
    session_id: str,
    uid: str,
    window_minutes: int,
    now: datetime | None = None,
) -> list[WindowPlan]:
    """Return closed windows that are ready to aggregate.

    A window is closed once wall-clock has passed its end; the trailing partial
    window waits for either more chunks or session end.
    """
    now = now or datetime.now(timezone.utc)
    rows = db.completed_chunks_for_session(session_id)
    if not rows:
        return []

    timed = [(chunk_event_time(row), row) for row in rows]
    timed = [(at, row) for at, row in timed if at is not None]
    if not timed:
        return []
    timed.sort(key=lambda pair: pair[0])

    done_keys = {row["aggregation_key"] for row in db.completed_aggregations(session_id)}

    plans: list[WindowPlan] = []
    cursor = timed[0][0]
    last = timed[-1][0]
    span = timedelta(minutes=window_minutes)

    while cursor <= last:
        end = cursor + span
        if end > now:
            # Still open; do not aggregate a window that can still grow.
            break
        selected = [row for at, row in timed if cursor <= at < end]
        key = window_key(session_id, cursor)
        if selected and key not in done_keys:
            plans.append(
                WindowPlan(
                    session_id=session_id,
                    uid=uid,
                    analysis_type="window",
                    start=cursor,
                    end=end,
                    rows=selected,
                    aggregation_key=key,
                )
            )
        cursor = end

    return plans


def plan_final(
    db: QueueDB, session_id: str, uid: str
) -> WindowPlan | None:
    rows = db.completed_chunks_for_session(session_id)
    if not rows:
        return None
    timed = [(chunk_event_time(row), row) for row in rows]
    timed = [(at, row) for at, row in timed if at is not None]
    if not timed:
        return None
    timed.sort(key=lambda pair: pair[0])

    return WindowPlan(
        session_id=session_id,
        uid=uid,
        analysis_type="final",
        start=timed[0][0],
        end=timed[-1][0] + timedelta(seconds=CHUNK_SECONDS),
        rows=[row for _, row in timed],
        aggregation_key=final_key(session_id),
    )


def coverage(actual: int, expected: int) -> float:
    if expected <= 0:
        return 1.0
    return max(0.0, min(1.0, actual / expected))


def build_analysis(
    plan: WindowPlan,
    chunk_payloads: Sequence[dict],
    llm,
    ladder: list[LlmConfig],
) -> AggregateAnalysis:
    """Run the LLM over a window and validate its output into the UI schema."""
    expected = expected_chunk_count(plan.start, plan.end)
    actual = len(chunk_payloads)
    missing = max(0, expected - actual)

    prompt = build_prompt(
        session_id=plan.session_id,
        analysis_type=plan.analysis_type,
        window_start=plan.start.isoformat(),
        window_end=plan.end.isoformat(),
        chunk_rows=chunk_payloads,
        missing_chunk_count=missing,
        expected_chunk_count=expected,
    )

    def _validate(payload: dict) -> None:
        """Reject a rung whose output cannot populate the report."""
        block = payload.get("concentration")
        if not isinstance(block, dict) or not block:
            raise LlmFailed("concentration block missing or empty")
        Concentration.model_validate(block)
        if not str(payload.get("summary") or "").strip():
            raise LlmFailed("summary missing")

    output = llm.generate(ladder, prompt, validate=_validate)
    payload = output.payload

    warnings: list[str] = []
    raw_quality = payload.get("data_quality") or {}
    if isinstance(raw_quality.get("warnings"), list):
        warnings = [
            str(item)
            for item in raw_quality["warnings"]
            if not _contradicts_coverage(str(item), missing)
        ][:20]
    if missing > 0:
        warnings.insert(
            0,
            f"この区間では理論上{expected}件に対し{actual}件しか分析できませんでした"
            f"（欠損{missing}件）。休憩、録画中断、アップロード失敗のいずれかの可能性があります。",
        )

    # coverage_ratio is computed here, not trusted from the model.
    ratio = coverage(actual, expected)

    try:
        concentration = Concentration.model_validate(payload.get("concentration") or {})
    except Exception as error:
        raise LlmFailed(f"concentration block invalid: {error}") from error

    return AggregateAnalysis(
        session_id=plan.session_id,
        analysis_type=plan.analysis_type,
        window=AnalysisWindow(
            start=plan.start.isoformat(),
            end=plan.end.isoformat(),
            chunk_count=actual,
            missing_chunk_count=missing,
        ),
        summary=str(payload.get("summary") or "").strip() or "要約を生成できませんでした。",
        concentration=concentration,
        observed_patterns=[str(item) for item in (payload.get("observed_patterns") or [])][:20],
        bottlenecks=[str(item) for item in (payload.get("bottlenecks") or [])][:20],
        recommendations=_coerce_recommendations(payload.get("recommendations"), missing),
        data_quality=DataQuality(coverage_ratio=ratio, warnings=warnings),
        runtime=output.runtime,
        generated_at=utc_now_iso(),
    )


# Words a model reaches for when claiming data is incomplete.
_GAP_TERMS = ("欠損", "不完全", "抜け", "missing", "incomplete", "gap")


def _contradicts_coverage(text: str, missing: int) -> bool:
    """Drop model claims of missing data when no data is missing.

    Coverage is computed locally precisely because the model cannot be trusted
    to report it — observed in production, gemma-3-12b-it warned about gaps and
    recommended investigating them for a window with 100% coverage. Surfacing
    that would tell a user their recording had holes when it did not.
    """
    if missing > 0:
        return False
    lowered = text.lower()
    return any(term in text or term in lowered for term in _GAP_TERMS)


def _coerce_recommendations(raw, missing: int = 0) -> list:
    from app.schemas import Recommendation

    if not isinstance(raw, list):
        return []
    results = []
    for index, item in enumerate(raw[:10]):
        if not isinstance(item, dict):
            continue
        try:
            item.setdefault("priority", index + 1)
            recommendation = Recommendation.model_validate(item)
        except Exception:
            # Drop the malformed entry rather than failing the whole report.
            log.debug("dropping malformed recommendation at index %d", index)
            continue

        blob = f"{recommendation.title} {recommendation.reason} {recommendation.action}"
        if _contradicts_coverage(blob, missing):
            log.info("dropping recommendation that invents missing data: %s",
                     recommendation.title)
            continue
        results.append(recommendation)
    return results


def analysis_object_path(plan: WindowPlan) -> str:
    if plan.analysis_type == "final":
        return result_store.final_analysis_path(plan.uid, plan.session_id)
    return result_store.window_analysis_path(
        plan.uid, plan.session_id, plan.start.isoformat()
    )
