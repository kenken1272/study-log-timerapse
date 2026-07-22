"""Test helpers.

Imported as a plain top-level module (`from helpers import make_ref`), which
pytest makes possible by putting the tests directory on sys.path. Importing
these through `tests.conftest` broke on the Ubuntu host, where an installed
copy under site-packages shadowed the source tree.
"""

from __future__ import annotations

import sqlite3

from app.schemas import ChunkRef, parse_chunk_object


def make_ref(
    segment: int = 0,
    chunk: int = 0,
    generation: str = "1",
    uid: str = "user-1",
    session: str = "sess-1",
) -> ChunkRef:
    return parse_chunk_object(
        f"users/{uid}/sessions/{session}/segments/{segment}/chunks/{chunk}.webm",
        generation,
    )


def rows_as_tuples(rows: list[sqlite3.Row]) -> list[tuple]:
    return [(row["segment_index"], row["chunk_index"]) for row in rows]
