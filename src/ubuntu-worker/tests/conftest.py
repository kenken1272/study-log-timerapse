from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.queue_db import QueueDB
from app.schemas import parse_chunk_object


@pytest.fixture()
def db(tmp_path: Path) -> QueueDB:
    database = QueueDB(tmp_path / "pipeline.db")
    yield database
    database.close()


def make_ref(segment: int = 0, chunk: int = 0, generation: str = "1",
             uid: str = "user-1", session: str = "sess-1"):
    return parse_chunk_object(
        f"users/{uid}/sessions/{session}/segments/{segment}/chunks/{chunk}.webm",
        generation,
    )


@pytest.fixture()
def ref_factory():
    return make_ref


def rows_as_tuples(rows: list[sqlite3.Row]) -> list[tuple]:
    return [(row["segment_index"], row["chunk_index"]) for row in rows]
