"""30-minute windows are event-time based, never chunk-count based."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import aggregator
from app.queue_db import STATE_COMPLETED, final_key, window_key
from tests.conftest import make_ref

BASE = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)


def complete_at(db, offset_seconds: int, chunk: int, segment: int = 0):
    ref = make_ref(segment=segment, chunk=chunk, generation=str(1000 + chunk))
    stamp = (BASE + timedelta(seconds=offset_seconds)).isoformat()
    db.enqueue(ref, "bucket", stamp)
    db.set_state(ref.idempotency_key, STATE_COMPLETED)
    return ref


def test_expected_count_for_thirty_minutes_is_sixty_not_one_fifty():
    assert aggregator.expected_chunk_count(BASE, BASE + timedelta(minutes=30)) == 60


def test_window_closes_on_elapsed_time_not_on_chunk_count(db):
    # Only 12 chunks arrived in the half hour — a break, not an incomplete window.
    for index in range(12):
        complete_at(db, index * 30, index)

    now = BASE + timedelta(minutes=45)
    plans = aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now)

    assert len(plans) == 1
    assert len(plans[0].rows) == 12
    assert plans[0].start == BASE


def test_an_open_window_is_not_aggregated_early(db):
    for index in range(10):
        complete_at(db, index * 30, index)

    now = BASE + timedelta(minutes=12)
    assert aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now) == []


def test_a_long_session_produces_consecutive_windows(db):
    for index in range(120):  # one hour of chunks
        complete_at(db, index * 30, index)

    now = BASE + timedelta(minutes=90)
    plans = aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now)

    assert len(plans) == 2
    assert plans[0].start == BASE
    assert plans[1].start == BASE + timedelta(minutes=30)
    assert plans[0].end == plans[1].start


def test_a_break_leaves_an_empty_window_unaggregated(db):
    # Chunks in the first 10 minutes, then a 40-minute gap, then more.
    for index in range(20):
        complete_at(db, index * 30, index)
    for index in range(20, 30):
        complete_at(db, 3000 + index * 30, index)

    now = BASE + timedelta(minutes=120)
    plans = aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now)

    # No empty window is produced for the break itself.
    assert all(plan.rows for plan in plans)


def test_a_completed_window_is_never_reaggregated(db):
    for index in range(60):
        complete_at(db, index * 30, index)
    now = BASE + timedelta(minutes=45)

    first = aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now)
    assert len(first) == 1

    key = first[0].aggregation_key
    assert db.claim_aggregation(key, "sess-1", "user-1", "window", None, None) is True
    db.finish_aggregation(key, "DONE")

    assert aggregator.plan_windows(db, "sess-1", "user-1", 30, now=now) == []


def test_a_failed_window_is_retried(db):
    key = window_key("sess-1", BASE)
    assert db.claim_aggregation(key, "sess-1", "user-1", "window", None, None) is True
    db.finish_aggregation(key, "FAILED", "llm crashed")

    assert db.claim_aggregation(key, "sess-1", "user-1", "window", None, None) is True


def test_a_running_window_is_not_claimed_twice(db):
    key = window_key("sess-1", BASE)
    assert db.claim_aggregation(key, "sess-1", "user-1", "window", None, None) is True
    assert db.claim_aggregation(key, "sess-1", "user-1", "window", None, None) is False


def test_final_analysis_is_claimed_exactly_once(db):
    key = final_key("sess-1")
    assert db.claim_aggregation(key, "sess-1", "user-1", "final", None, None) is True
    db.finish_aggregation(key, "DONE")
    assert db.claim_aggregation(key, "sess-1", "user-1", "final", None, None) is False


def test_final_plan_spans_the_whole_session_across_segments(db):
    for index in range(10):
        complete_at(db, index * 30, index, segment=0)
    for index in range(10):
        complete_at(db, 600 + index * 30, index, segment=1)

    plan = aggregator.plan_final(db, "sess-1", "user-1")
    assert plan is not None
    assert plan.analysis_type == "final"
    assert len(plan.rows) == 20
    assert plan.start == BASE


def test_final_plan_is_none_without_analysable_chunks(db):
    db.enqueue(make_ref(), "bucket")  # received but never completed
    assert aggregator.plan_final(db, "sess-1", "user-1") is None


def test_coverage_ratio_is_bounded():
    assert aggregator.coverage(0, 60) == 0.0
    assert aggregator.coverage(30, 60) == 0.5
    assert aggregator.coverage(90, 60) == 1.0
    assert aggregator.coverage(5, 0) == 1.0


def test_analysis_paths_always_include_the_uid():
    plan = aggregator.WindowPlan("sess-1", "user-1", "final", BASE, BASE, [], "k")
    assert aggregator.analysis_object_path(plan) == "users/user-1/sessions/sess-1/analysis.json"

    window = aggregator.WindowPlan("sess-1", "user-1", "window", BASE, BASE, [], "k")
    path = aggregator.analysis_object_path(window)
    assert path.startswith("users/user-1/sessions/sess-1/analysis/windows/")
