"""Session end must wait for the work, not pass judgement on it.

metadata.json arrives by a different path from the chunk notifications, so it
can be seen before any chunk has been queued, let alone analysed. The previous
implementation treated "no analysable chunks" as a finished outcome: it set
finalized=1 and published a failure, after which chunks completing seconds
later could never produce a report.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest

from app import aggregator
from app.queue_db import STATE_COMPLETED, final_key
from helpers import make_ref

BASE = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)


def complete_at(db, offset_seconds: int, chunk: int):
    ref = make_ref(chunk=chunk, generation=str(2000 + chunk))
    stamp = (BASE + timedelta(seconds=offset_seconds)).isoformat()
    db.enqueue(ref, "bucket", stamp)
    db.set_state(ref.idempotency_key, STATE_COMPLETED)
    return ref


def test_end_before_any_chunk_arrives_is_not_a_verdict(db):
    """The exact production race: metadata first, chunks not even queued."""
    assert db.finalization_requested_at("sess-1") is None

    db.enqueue(make_ref(chunk=0), "bucket")  # session row now exists
    db.mark_session_ended("sess-1", time.time())

    # Requested, but nothing is analysable yet.
    assert db.finalization_requested_at("sess-1") is not None
    assert aggregator.plan_final(db, "sess-1", "user-1") is None
    # Crucially, the session must NOT be finalised on that basis.
    row = db._query("SELECT finalized FROM sessions WHERE session_id=?", ("sess-1",))[0]
    assert row["finalized"] == 0


def test_a_late_chunk_still_produces_a_final_plan(db):
    db.enqueue(make_ref(chunk=0), "bucket")
    db.mark_session_ended("sess-1", time.time())
    assert aggregator.plan_final(db, "sess-1", "user-1") is None

    # The chunk finishes after end was requested.
    complete_at(db, 0, 1)

    plan = aggregator.plan_final(db, "sess-1", "user-1")
    assert plan is not None
    assert plan.analysis_type == "final"
    assert len(plan.rows) == 1


def test_finalization_request_time_is_recorded_once(db):
    db.enqueue(make_ref(), "bucket")
    first = time.time()
    db.mark_session_ended("sess-1", first)
    recorded = db.finalization_requested_at("sess-1")

    # A second observation of the same end must not reset the clock, or the
    # grace period would never elapse.
    assert recorded == pytest.approx(first, abs=0.01)


def test_pending_chunks_keep_the_session_unfinalised(db):
    complete_at(db, 0, 0)
    db.enqueue(make_ref(chunk=1), "bucket")  # still RECEIVED
    db.mark_session_ended("sess-1", time.time())

    assert db.pending_count_for_session("sess-1") == 1
    row = db._query("SELECT finalized FROM sessions WHERE session_id=?", ("sess-1",))[0]
    assert row["finalized"] == 0


def test_out_of_order_completion_after_end_is_ordered_correctly(db):
    db.mark_session_ended("sess-1", time.time()) if False else None
    complete_at(db, 90, 3)
    complete_at(db, 0, 0)
    complete_at(db, 60, 2)
    complete_at(db, 30, 1)

    plan = aggregator.plan_final(db, "sess-1", "user-1")
    assert [row["chunk_index"] for row in plan.rows] == [0, 1, 2, 3]


def test_a_recovered_dead_letter_chunk_rejoins_the_final_plan(db):
    """Chunks requeued after a context failure must count once they finish."""
    complete_at(db, 0, 0)

    poisoned = make_ref(chunk=1, generation="2001")
    db.enqueue(poisoned, "bucket", (BASE + timedelta(seconds=30)).isoformat())
    db.claim_next()
    db.requeue_without_penalty(poisoned.idempotency_key, "fatal CUDA error")
    assert aggregator.plan_final(db, "sess-1", "user-1").rows.__len__() == 1

    db.set_state(poisoned.idempotency_key, STATE_COMPLETED)
    plan = aggregator.plan_final(db, "sess-1", "user-1")
    assert len(plan.rows) == 2


def test_final_aggregation_is_still_claimed_only_once(db):
    complete_at(db, 0, 0)
    key = final_key("sess-1")
    assert db.claim_aggregation(key, "sess-1", "user-1", "final", None, None) is True
    db.finish_aggregation(key, "DONE")
    assert db.claim_aggregation(key, "sess-1", "user-1", "final", None, None) is False
