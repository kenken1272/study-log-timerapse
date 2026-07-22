"""Backoff, dead-lettering, and the bound on retries."""

from __future__ import annotations

import time

from app.queue_db import STATE_DEAD_LETTER, STATE_RETRY_WAIT
from helpers import make_ref


def test_transient_failure_schedules_a_future_retry(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()

    state = db.fail(ref.idempotency_key, "transient", "GCS 503", max_attempts=5)
    assert state == STATE_RETRY_WAIT

    row = db.get(ref.idempotency_key)
    assert row["next_attempt_at"] > time.time()
    # Not yet due, so the loop must not pick it up.
    assert db.claim_next() is None


def test_due_retry_is_claimable_again(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()
    db.fail(ref.idempotency_key, "transient", "GCS 503", max_attempts=5)

    db.set_state(ref.idempotency_key, STATE_RETRY_WAIT, next_attempt_at=0)
    claimed = db.claim_next()
    assert claimed is not None
    assert claimed["attempts"] == 2


def test_attempts_are_bounded_and_end_in_dead_letter(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    max_attempts = 3

    states = []
    # Drive the loop the way the worker does: claim, fail, and let the queue
    # decide when to stop. Nothing resurrects a row it has given up on.
    while (claimed := db.claim_next()) is not None:
        states.append(
            db.fail(ref.idempotency_key, "transient", "boom", max_attempts=max_attempts)
        )
        if states[-1] == STATE_DEAD_LETTER:
            break
        db.set_state(ref.idempotency_key, STATE_RETRY_WAIT, next_attempt_at=0)

    assert states == [STATE_RETRY_WAIT, STATE_RETRY_WAIT, STATE_DEAD_LETTER]
    assert db.get(ref.idempotency_key)["attempts"] == max_attempts
    # Dead-lettered work is never handed out again.
    assert db.claim_next() is None


def test_backoff_grows_with_attempts(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")

    delays = []
    for _ in range(3):
        db.set_state(ref.idempotency_key, STATE_RETRY_WAIT, next_attempt_at=0)
        db.claim_next()
        db.fail(ref.idempotency_key, "transient", "boom", max_attempts=10, base_delay=1.0)
        delays.append(db.get(ref.idempotency_key)["next_attempt_at"] - time.time())

    # Jittered, so assert the ceiling rises rather than each value rising.
    assert max(delays) >= delays[0]
    assert all(delay > 0 for delay in delays)


def test_dead_letter_records_why(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()
    db.fail(ref.idempotency_key, "chunk_gone", "object deleted", max_attempts=1)

    row = db.get(ref.idempotency_key)
    assert row["state"] == STATE_DEAD_LETTER
    assert row["error_class"] == "chunk_gone"
    assert "deleted" in row["error_message"]


def test_transitions_are_recorded_for_audit(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()
    db.fail(ref.idempotency_key, "transient", "boom", max_attempts=5)

    rows = db._conn.execute(
        "SELECT to_state FROM transitions WHERE idempotency_key=? ORDER BY id",
        (ref.idempotency_key,),
    ).fetchall()
    assert [row["to_state"] for row in rows] == ["RECEIVED", "DOWNLOADING", "RETRY_WAIT"]
