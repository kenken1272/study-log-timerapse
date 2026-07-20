"""Delivery order carries no information; the timeline is rebuilt on read."""

from __future__ import annotations

from app.queue_db import STATE_COMPLETED
from tests.conftest import make_ref, rows_as_tuples


def _complete(db, segment, chunk, generation="1", time_created=None):
    ref = make_ref(segment=segment, chunk=chunk, generation=generation)
    db.enqueue(ref, "bucket", time_created)
    db.set_state(ref.idempotency_key, STATE_COMPLETED)
    return ref


def test_reversed_arrival_is_sorted_back_into_timeline_order(db):
    for chunk in (4, 0, 3, 1, 2):
        _complete(db, 0, chunk)

    rows = db.completed_chunks_for_session("sess-1")
    assert rows_as_tuples(rows) == [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)]


def test_segments_order_before_chunk_index(db):
    # Each segment restarts chunk_index at 0, so a naive sort on chunk_index
    # alone would interleave a resumed recording with the original.
    _complete(db, 1, 0)
    _complete(db, 0, 1)
    _complete(db, 1, 1)
    _complete(db, 0, 0)

    rows = db.completed_chunks_for_session("sess-1")
    assert rows_as_tuples(rows) == [(0, 0), (0, 1), (1, 0), (1, 1)]


def test_reupload_of_same_slot_orders_by_creation_time(db):
    _complete(db, 0, 0, generation="200", time_created="2026-07-20T10:00:30Z")
    _complete(db, 0, 0, generation="100", time_created="2026-07-20T10:00:00Z")

    rows = db.completed_chunks_for_session("sess-1")
    assert [row["generation"] for row in rows] == ["100", "200"]


def test_incomplete_chunks_are_excluded_from_the_timeline(db):
    _complete(db, 0, 0)
    pending = make_ref(segment=0, chunk=1)
    db.enqueue(pending, "bucket")  # still RECEIVED

    rows = db.completed_chunks_for_session("sess-1")
    assert rows_as_tuples(rows) == [(0, 0)]


def test_sessions_do_not_leak_into_each_other(db):
    db.enqueue(make_ref(session="sess-1"), "bucket")
    other = make_ref(session="sess-2")
    db.enqueue(other, "bucket")
    db.set_state(other.idempotency_key, STATE_COMPLETED)

    assert db.completed_chunks_for_session("sess-1") == []
    assert len(db.completed_chunks_for_session("sess-2")) == 1
