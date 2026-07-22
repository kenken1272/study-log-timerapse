"""The queue is touched from several threads at once.

Pub/Sub delivers on its own callback threads while the chunk loop and window
loop run concurrently. An earlier version created the SQLite connection on the
main thread and blew up in production with "SQLite objects created in a thread
can only be used in that same thread" — single-threaded tests never saw it.
"""

from __future__ import annotations

import threading

from app.queue_db import STATE_COMPLETED
from helpers import make_ref


def _run_concurrently(target, count: int) -> list[BaseException]:
    errors: list[BaseException] = []
    lock = threading.Lock()

    def wrapper(index: int) -> None:
        try:
            target(index)
        except BaseException as error:  # noqa: BLE001 - the point is to catch all
            with lock:
                errors.append(error)

    threads = [threading.Thread(target=wrapper, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return errors


def test_enqueue_works_from_other_threads(db):
    errors = _run_concurrently(
        lambda index: db.enqueue(make_ref(chunk=index), "bucket"), 16
    )
    assert errors == []
    assert db.session_counts("sess-1")["TOTAL"] == 16


def test_reads_work_from_other_threads(db):
    for index in range(8):
        ref = make_ref(chunk=index)
        db.enqueue(ref, "bucket")
        db.set_state(ref.idempotency_key, STATE_COMPLETED)

    results: list[int] = []
    lock = threading.Lock()

    def read(_index: int) -> None:
        rows = db.completed_chunks_for_session("sess-1")
        counts = db.session_counts("sess-1")
        db.pending_count_for_session("sess-1")
        db.active_sessions()
        db.get_meta("vlm_profile")
        with lock:
            results.append(len(rows) + counts["TOTAL"])

    errors = _run_concurrently(read, 12)
    assert errors == []
    assert all(value == 16 for value in results)


def test_concurrent_claims_never_hand_out_the_same_chunk(db):
    for index in range(20):
        db.enqueue(make_ref(chunk=index), "bucket")

    claimed: list[str] = []
    lock = threading.Lock()

    def claim(_index: int) -> None:
        while True:
            row = db.claim_next()
            if row is None:
                return
            with lock:
                claimed.append(row["idempotency_key"])

    errors = _run_concurrently(claim, 6)
    assert errors == []
    # Each chunk goes to exactly one worker.
    assert len(claimed) == 20
    assert len(set(claimed)) == 20


def test_concurrent_aggregation_claims_elect_one_winner(db):
    winners: list[bool] = []
    lock = threading.Lock()

    def claim(_index: int) -> None:
        won = db.claim_aggregation("sess-1|final", "sess-1", "user-1", "final", None, None)
        with lock:
            winners.append(won)

    errors = _run_concurrently(claim, 10)
    assert errors == []
    assert winners.count(True) == 1


def test_mixed_readers_and_writers_do_not_corrupt_state(db):
    def mixed(index: int) -> None:
        if index % 2 == 0:
            ref = make_ref(chunk=index)
            db.enqueue(ref, "bucket")
            db.set_state(ref.idempotency_key, STATE_COMPLETED)
        else:
            db.completed_chunks_for_session("sess-1")
            db.session_counts("sess-1")

    errors = _run_concurrently(mixed, 20)
    assert errors == []
    assert db.session_counts("sess-1")[STATE_COMPLETED] == 10
