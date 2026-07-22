"""Pub/Sub delivers at-least-once; the queue must absorb that."""

from __future__ import annotations

from app.queue_db import STATE_COMPLETED, STATE_RECEIVED
from helpers import make_ref


def test_duplicate_delivery_is_ignored(db):
    ref = make_ref()
    assert db.enqueue(ref, "bucket") is True
    assert db.enqueue(ref, "bucket") is False
    assert db.session_counts("sess-1")["TOTAL"] == 1


def test_redelivery_after_completion_does_not_reopen_work(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.set_state(ref.idempotency_key, STATE_COMPLETED)

    # Pub/Sub can redeliver long after we acked and finished.
    assert db.enqueue(ref, "bucket") is False
    assert db.get(ref.idempotency_key)["state"] == STATE_COMPLETED
    assert db.claim_next() is None


def test_same_object_different_generation_is_separate_work(db):
    first = make_ref(generation="100")
    second = make_ref(generation="200")
    assert db.enqueue(first, "bucket") is True
    assert db.enqueue(second, "bucket") is True
    assert db.session_counts("sess-1")["TOTAL"] == 2


def test_claim_marks_in_flight_and_is_not_handed_out_twice(db):
    db.enqueue(make_ref(chunk=0), "bucket")
    db.enqueue(make_ref(chunk=1), "bucket")

    first = db.claim_next()
    second = db.claim_next()
    assert first["idempotency_key"] != second["idempotency_key"]
    assert db.claim_next() is None


def test_restart_recovers_abandoned_in_flight_chunks(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()  # now DOWNLOADING — simulate the process dying here

    recovered = db.recover_in_flight()
    assert recovered == 1
    assert db.get(ref.idempotency_key)["state"] == STATE_RECEIVED
    # The work is available again after restart.
    assert db.claim_next() is not None


def test_completed_chunks_are_not_rewound_by_recovery(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.set_state(ref.idempotency_key, STATE_COMPLETED)
    assert db.recover_in_flight() == 0
    assert db.get(ref.idempotency_key)["state"] == STATE_COMPLETED
