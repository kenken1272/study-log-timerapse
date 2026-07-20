"""Fatal CUDA errors must end the process, not the chunk.

A sticky CUDA error poisons the context for the whole process and every device
in it. In production one Xid 13 on GPU1 was followed two seconds later by the
VLM failing on GPU0 with valid input; the worker retried in the same process,
so four healthy chunks burned all five attempts against a dead context and were
dead-lettered. Re-run in a fresh process, one of those chunks succeeded first
time.
"""

from __future__ import annotations

import pytest

from app.cuda_health import (
    FATAL_CUDA_EXIT_CODE,
    FatalCudaError,
    is_fatal_cuda_error,
    raise_if_fatal,
)
from app.queue_db import STATE_RECEIVED
from helpers import make_ref


@pytest.mark.parametrize(
    "message",
    [
        "CUDA error: misaligned address",
        "CUDA error: an illegal memory access was encountered",
        "CUDA error: device-side assert triggered",
        "CUDA error: unspecified launch failure",
        "uncorrectable ECC error encountered",
    ],
)
def test_context_destroying_errors_are_fatal(message):
    assert is_fatal_cuda_error(RuntimeError(message)) is True


@pytest.mark.parametrize(
    "message",
    [
        "CUDA out of memory. Tried to allocate 8.00 GiB",
        "cuda out of memory",
    ],
)
def test_oom_is_not_fatal(message):
    # OOM is recoverable and belongs to the fallback ladder. Treating it as
    # fatal would restart the worker on ordinary memory pressure.
    assert is_fatal_cuda_error(RuntimeError(message)) is False


@pytest.mark.parametrize(
    "message",
    [
        "model repo not found",
        "expected a single JSON object",
        "connection reset by peer",
    ],
)
def test_ordinary_failures_are_not_fatal(message):
    assert is_fatal_cuda_error(RuntimeError(message)) is False


def test_raise_if_fatal_wraps_only_fatal_errors():
    with pytest.raises(FatalCudaError):
        raise_if_fatal(RuntimeError("CUDA error: misaligned address"))

    # Returns quietly for anything else.
    assert raise_if_fatal(RuntimeError("some other problem")) is None


def test_exit_code_is_distinct_from_generic_failure():
    # Distinguishable in journalctl from an ordinary crash.
    assert FATAL_CUDA_EXIT_CODE not in (0, 1, 2)


def test_context_failure_does_not_consume_a_chunks_attempts(db):
    """The whole point: a poisoned context says nothing about the chunk."""
    ref = make_ref()
    db.enqueue(ref, "bucket")

    # Burn some attempts the ordinary way.
    for _ in range(3):
        db.set_state(ref.idempotency_key, "RETRY_WAIT", next_attempt_at=0)
        db.claim_next()
    before = db.get(ref.idempotency_key)["attempts"]

    db.requeue_without_penalty(ref.idempotency_key, "fatal CUDA error during VLM")

    row = db.get(ref.idempotency_key)
    assert row["state"] == STATE_RECEIVED
    assert row["attempts"] < before
    assert row["error_class"] == "fatal_cuda"
    assert row["next_attempt_at"] == 0  # available to the next process at once


def test_requeued_chunk_is_claimable_immediately(db):
    ref = make_ref()
    db.enqueue(ref, "bucket")
    db.claim_next()
    db.requeue_without_penalty(ref.idempotency_key, "fatal CUDA error")

    assert db.claim_next() is not None


def test_a_chunk_is_never_lost_to_a_context_failure(db):
    """Four chunks, all hit by one poisoned context, must all survive."""
    refs = [make_ref(chunk=index) for index in range(4)]
    for ref in refs:
        db.enqueue(ref, "bucket")

    # Each is claimed and then hit by the same poisoned context, exactly as the
    # four production chunks were.
    while (claimed := db.claim_next()) is not None:
        db.requeue_without_penalty(claimed["idempotency_key"], "fatal CUDA error")
        if db.session_counts("sess-1").get("RECEIVED", 0) == 4:
            break

    counts = db.session_counts("sess-1")
    assert counts.get("DEAD_LETTER", 0) == 0
    assert counts[STATE_RECEIVED] == 4
