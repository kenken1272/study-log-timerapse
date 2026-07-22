"""The durable job row: idempotency, single concurrency, recovery, ceilings.

A timelapse render costs minutes of CPU and ends by mutating a user-visible
session. Starting one twice, or losing track of one that was interrupted, are
both worse than starting late.
"""

from __future__ import annotations

import time

import pytest

from app.queue_db import (
    MAX_TIMELAPSE_ATTEMPTS,
    TL_CALLBACK_PENDING,
    TL_COMPLETED,
    TL_DEAD_LETTER,
    TL_ENCODING,
    TL_READY,
    TL_RETRY,
    TL_UPLOADING,
    TL_WAITING_FOR_CHUNKS,
)


def ready_job(db, session="s1", uid="u1"):
    db.upsert_timelapse_job(session, uid, TL_WAITING_FOR_CHUNKS)
    db.set_timelapse_state(session, TL_READY)
    return session


# --- idempotency ---

def test_a_session_gets_exactly_one_job(db):
    assert db.upsert_timelapse_job("s1", "u1", TL_WAITING_FOR_CHUNKS) is True
    assert db.upsert_timelapse_job("s1", "u1", TL_WAITING_FOR_CHUNKS) is False


def test_repeated_triggers_do_not_reset_progress(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.set_timelapse_state("s1", TL_ENCODING)

    # A duplicate end-of-session signal must not knock a running render back.
    db.upsert_timelapse_job("s1", "u1", TL_WAITING_FOR_CHUNKS)
    assert db.get_timelapse_job("s1")["state"] == TL_ENCODING


def test_a_job_cannot_be_claimed_twice(db):
    ready_job(db)
    assert db.claim_timelapse_job("s1") is True
    assert db.claim_timelapse_job("s1") is False


def test_a_completed_job_is_not_reclaimed(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.set_timelapse_state("s1", TL_COMPLETED)
    assert db.claim_timelapse_job("s1") is False


# --- single concurrency ---

def test_only_one_render_holds_the_slot(db):
    """ffmpeg saturates the CPU; a second render would fight the VLM for it."""
    ready_job(db, "s1")
    ready_job(db, "s2")

    assert db.claim_timelapse_job("s1") is True
    assert db.timelapse_job_in_progress() is True

    # The gate the worker checks before starting anything else.
    db.set_timelapse_state("s1", TL_COMPLETED)
    assert db.timelapse_job_in_progress() is False
    assert db.claim_timelapse_job("s2") is True


@pytest.mark.parametrize("state", [TL_ENCODING, TL_UPLOADING])
def test_every_in_flight_state_holds_the_slot(db, state):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.set_timelapse_state("s1", state)
    assert db.timelapse_job_in_progress() is True


def test_a_waiting_job_does_not_hold_the_slot(db):
    db.upsert_timelapse_job("s1", "u1", TL_WAITING_FOR_CHUNKS)
    assert db.timelapse_job_in_progress() is False


# --- restart recovery ---

def test_an_interrupted_render_is_recovered(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.set_timelapse_state("s1", TL_ENCODING)   # process dies here

    assert db.recover_timelapse_jobs() == 1
    assert db.get_timelapse_job("s1")["state"] == TL_READY
    assert db.claim_timelapse_job("s1") is True


def test_recovery_leaves_completed_jobs_alone(db):
    ready_job(db)
    db.set_timelapse_state("s1", TL_COMPLETED)
    assert db.recover_timelapse_jobs() == 0
    assert db.get_timelapse_job("s1")["state"] == TL_COMPLETED


def test_recovery_leaves_callback_pending_alone(db):
    """The render is done and uploaded; only the callback still owes work.

    Rewinding it would redo minutes of encoding for nothing.
    """
    ready_job(db)
    db.set_timelapse_state("s1", TL_CALLBACK_PENDING)
    assert db.recover_timelapse_jobs() == 0
    assert db.get_timelapse_job("s1")["state"] == TL_CALLBACK_PENDING


# --- retry and ceiling ---

def test_failure_backs_off_before_retrying(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    assert db.fail_timelapse_job("s1", "ffmpeg", "boom") == TL_RETRY

    # Not immediately claimable.
    assert db.claim_timelapse_job("s1") is False
    assert db.get_timelapse_job("s1")["next_attempt_at"] > time.time()


def test_a_due_retry_is_claimable(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.fail_timelapse_job("s1", "ffmpeg", "boom")
    db.set_timelapse_state("s1", TL_RETRY, next_attempt_at=0)
    assert db.claim_timelapse_job("s1") is True


def test_attempts_are_bounded(db):
    ready_job(db)
    claims = 0
    while db.claim_timelapse_job("s1"):
        claims += 1
        if db.fail_timelapse_job("s1", "ffmpeg", "boom") == TL_DEAD_LETTER:
            break
        db.set_timelapse_state("s1", TL_RETRY, next_attempt_at=0)

    assert claims <= MAX_TIMELAPSE_ATTEMPTS
    assert db.get_timelapse_job("s1")["state"] == TL_DEAD_LETTER
    assert db.claim_timelapse_job("s1") is False


def test_backoff_grows(db):
    ready_job(db)
    delays = []
    for _ in range(3):
        db.set_timelapse_state("s1", TL_RETRY, next_attempt_at=0)
        db.claim_timelapse_job("s1")
        db.fail_timelapse_job("s1", "ffmpeg", "boom")
        delays.append(db.get_timelapse_job("s1")["next_attempt_at"] - time.time())

    assert all(d > 0 for d in delays)
    assert delays[-1] > delays[0]


def test_the_failure_reason_is_kept(db):
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.fail_timelapse_job("s1", "ffmpeg", "exited 1: no such filter")
    row = db.get_timelapse_job("s1")
    assert row["error_class"] == "ffmpeg"
    assert "no such filter" in row["error_message"]


# --- fingerprint bookkeeping ---

def test_the_fingerprint_of_a_completed_render_is_recorded(db):
    """How a later trigger knows whether the sources have changed."""
    ready_job(db)
    db.claim_timelapse_job("s1")
    db.set_timelapse_state(
        "s1", TL_COMPLETED, source_fingerprint="abc123",
        output_object="users/u1/sessions/s1/timelapse.mp4",
    )
    row = db.get_timelapse_job("s1")
    assert row["source_fingerprint"] == "abc123"
    assert row["output_object"].endswith("/timelapse.mp4")


def test_jobs_awaiting_excludes_completed_and_dead(db):
    ready_job(db, "s1")
    ready_job(db, "s2")
    ready_job(db, "s3")
    db.set_timelapse_state("s1", TL_COMPLETED)
    db.set_timelapse_state("s2", TL_DEAD_LETTER)

    awaiting = {row["session_id"] for row in db.timelapse_jobs_awaiting()}
    assert awaiting == {"s3"}


def test_callback_pending_jobs_are_picked_up_again(db):
    """An unconfirmed upload must not be forgotten."""
    ready_job(db)
    db.set_timelapse_state("s1", TL_CALLBACK_PENDING)
    awaiting = {row["session_id"] for row in db.timelapse_jobs_awaiting()}
    assert "s1" in awaiting
