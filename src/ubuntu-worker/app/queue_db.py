"""Durable SQLite work queue.

Pub/Sub messages are acked as soon as they are committed here, so this file is
the only thing standing between a worker crash and a lost chunk. Everything is
written with WAL + a UNIQUE idempotency key so redelivery is a no-op.
"""

from __future__ import annotations

import random
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Sequence

from app.schemas import ChunkRef

# Terminal and in-flight states. Anything not COMPLETED or DEAD_LETTER is
# resumable after a restart.
STATE_RECEIVED = "RECEIVED"
STATE_DOWNLOADING = "DOWNLOADING"
STATE_DOWNLOADED = "DOWNLOADED"
STATE_EXTRACTING = "EXTRACTING"
STATE_VLM_RUNNING = "VLM_RUNNING"
STATE_VLM_DONE = "VLM_DONE"
STATE_UPLOADING = "UPLOADING"
STATE_COMPLETED = "COMPLETED"
STATE_RETRY_WAIT = "RETRY_WAIT"
STATE_DEAD_LETTER = "DEAD_LETTER"

TERMINAL_STATES = (STATE_COMPLETED, STATE_DEAD_LETTER)

# States that mean "a previous process was mid-flight and died". On startup
# these are rewound to RECEIVED so the work restarts from a clean point.
IN_FLIGHT_STATES = (
    STATE_DOWNLOADING,
    STATE_DOWNLOADED,
    STATE_EXTRACTING,
    STATE_VLM_RUNNING,
    STATE_VLM_DONE,
    STATE_UPLOADING,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
  idempotency_key TEXT PRIMARY KEY,
  bucket          TEXT NOT NULL,
  object_name     TEXT NOT NULL,
  generation      TEXT NOT NULL,
  uid             TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  segment_index   INTEGER NOT NULL,
  chunk_index     INTEGER NOT NULL,
  gcs_time_created TEXT,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  error_class     TEXT,
  error_message   TEXT,
  local_path      TEXT,
  result_object   TEXT,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_state ON chunks(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id, segment_index, chunk_index);

CREATE TABLE IF NOT EXISTS transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  at              REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_key ON transitions(idempotency_key);

-- One row per aggregation unit, so a 30-minute window or a final report can
-- never be produced twice for the same session.
CREATE TABLE IF NOT EXISTS aggregations (
  aggregation_key TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  uid             TEXT NOT NULL,
  analysis_type   TEXT NOT NULL,
  window_start    TEXT,
  window_end      TEXT,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  uid             TEXT NOT NULL,
  first_seen_at   REAL NOT NULL,
  last_chunk_at   REAL NOT NULL,
  ended_at        REAL,
  finalized       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _now() -> float:
    return time.time()


class QueueDB:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), timeout=30.0, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield self._conn
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        else:
            self._conn.execute("COMMIT")

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    def enqueue(
        self, ref: ChunkRef, bucket: str, time_created: str | None = None
    ) -> bool:
        """Record a chunk. Returns False when this exact delivery is a duplicate.

        Must be committed before the Pub/Sub message is acked.
        """
        now = _now()
        with self._tx() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO chunks (
                  idempotency_key, bucket, object_name, generation,
                  uid, session_id, segment_index, chunk_index,
                  gcs_time_created, state, attempts, next_attempt_at,
                  created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?)
                """,
                (
                    ref.idempotency_key,
                    bucket,
                    ref.object_name,
                    ref.generation,
                    ref.uid,
                    ref.session_id,
                    ref.segment_index,
                    ref.chunk_index,
                    time_created,
                    STATE_RECEIVED,
                    now,
                    now,
                ),
            )
            inserted = cursor.rowcount > 0
            if inserted:
                conn.execute(
                    "INSERT INTO transitions (idempotency_key, from_state, to_state, at)"
                    " VALUES (?,?,?,?)",
                    (ref.idempotency_key, None, STATE_RECEIVED, now),
                )
                conn.execute(
                    """
                    INSERT INTO sessions (session_id, uid, first_seen_at, last_chunk_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT(session_id) DO UPDATE SET last_chunk_at=excluded.last_chunk_at
                    """,
                    (ref.session_id, ref.uid, now, now),
                )
        return inserted

    # ------------------------------------------------------------------
    # Work loop
    # ------------------------------------------------------------------

    def claim_next(self) -> sqlite3.Row | None:
        """Atomically take the oldest ready chunk and mark it DOWNLOADING."""
        now = _now()
        with self._tx() as conn:
            row = conn.execute(
                """
                SELECT * FROM chunks
                 WHERE state IN (?, ?) AND next_attempt_at <= ?
                 ORDER BY created_at ASC
                 LIMIT 1
                """,
                (STATE_RECEIVED, STATE_RETRY_WAIT, now),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE chunks SET state=?, attempts=attempts+1, updated_at=?"
                " WHERE idempotency_key=?",
                (STATE_DOWNLOADING, now, row["idempotency_key"]),
            )
            conn.execute(
                "INSERT INTO transitions (idempotency_key, from_state, to_state, at)"
                " VALUES (?,?,?,?)",
                (row["idempotency_key"], row["state"], STATE_DOWNLOADING, now),
            )
        return self.get(row["idempotency_key"])

    def set_state(self, key: str, state: str, **fields: object) -> None:
        now = _now()
        assignments = ["state=?", "updated_at=?"]
        values: list[object] = [state, now]
        for name, value in fields.items():
            assignments.append(f"{name}=?")
            values.append(value)
        values.append(key)
        with self._tx() as conn:
            previous = conn.execute(
                "SELECT state FROM chunks WHERE idempotency_key=?", (key,)
            ).fetchone()
            conn.execute(
                f"UPDATE chunks SET {', '.join(assignments)} WHERE idempotency_key=?",
                values,
            )
            conn.execute(
                "INSERT INTO transitions (idempotency_key, from_state, to_state, at)"
                " VALUES (?,?,?,?)",
                (key, previous["state"] if previous else None, state, now),
            )

    def fail(
        self,
        key: str,
        error_class: str,
        message: str,
        max_attempts: int,
        base_delay: float = 5.0,
    ) -> str:
        """Schedule a retry with exponential backoff + jitter, or dead-letter."""
        row = self.get(key)
        attempts = row["attempts"] if row else max_attempts
        if attempts >= max_attempts:
            self.set_state(
                key,
                STATE_DEAD_LETTER,
                error_class=error_class,
                error_message=message[:2000],
            )
            return STATE_DEAD_LETTER

        # Full jitter: avoids a thundering herd when GCS or the GPU recovers.
        backoff = min(base_delay * (2 ** (attempts - 1)), 600.0)
        delay = random.uniform(base_delay, backoff) if backoff > base_delay else base_delay
        self.set_state(
            key,
            STATE_RETRY_WAIT,
            error_class=error_class,
            error_message=message[:2000],
            next_attempt_at=_now() + delay,
        )
        return STATE_RETRY_WAIT

    def get(self, key: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM chunks WHERE idempotency_key=?", (key,)
        ).fetchone()

    def recover_in_flight(self) -> int:
        """Rewind chunks abandoned by a previous process back to RECEIVED."""
        now = _now()
        placeholders = ",".join("?" * len(IN_FLIGHT_STATES))
        with self._tx() as conn:
            cursor = conn.execute(
                f"UPDATE chunks SET state=?, updated_at=? WHERE state IN ({placeholders})",
                (STATE_RECEIVED, now, *IN_FLIGHT_STATES),
            )
            return cursor.rowcount

    # ------------------------------------------------------------------
    # Ordering & aggregation
    # ------------------------------------------------------------------

    def completed_chunks_for_session(self, session_id: str) -> list[sqlite3.Row]:
        """Completed chunks in stable timeline order.

        Pub/Sub delivery order means nothing, and segments restart chunk_index
        at 0, so ordering is (segment, chunk) with GCS creation time only as a
        tiebreak for re-uploads of the same slot.
        """
        return list(
            self._conn.execute(
                """
                SELECT * FROM chunks
                 WHERE session_id=? AND state=?
                 ORDER BY segment_index ASC, chunk_index ASC,
                          COALESCE(gcs_time_created, '') ASC
                """,
                (session_id, STATE_COMPLETED),
            )
        )

    def pending_count_for_session(self, session_id: str) -> int:
        row = self._conn.execute(
            f"""
            SELECT COUNT(*) AS n FROM chunks
             WHERE session_id=? AND state NOT IN ({','.join('?' * len(TERMINAL_STATES))})
            """,
            (session_id, *TERMINAL_STATES),
        ).fetchone()
        return int(row["n"])

    def session_counts(self, session_id: str) -> dict[str, int]:
        rows = self._conn.execute(
            "SELECT state, COUNT(*) AS n FROM chunks WHERE session_id=? GROUP BY state",
            (session_id,),
        ).fetchall()
        counts = {row["state"]: int(row["n"]) for row in rows}
        counts["TOTAL"] = sum(counts.values())
        return counts

    def active_sessions(self) -> list[sqlite3.Row]:
        return list(
            self._conn.execute("SELECT * FROM sessions WHERE finalized=0")
        )

    def mark_session_ended(self, session_id: str, ended_at: float) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sessions SET ended_at=? WHERE session_id=?",
                (ended_at, session_id),
            )

    def mark_session_finalized(self, session_id: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sessions SET finalized=1 WHERE session_id=?", (session_id,)
            )

    def claim_aggregation(
        self,
        aggregation_key: str,
        session_id: str,
        uid: str,
        analysis_type: str,
        window_start: str | None,
        window_end: str | None,
    ) -> bool:
        """Reserve an aggregation unit. False means someone already produced it."""
        now = _now()
        with self._tx() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO aggregations (
                  aggregation_key, session_id, uid, analysis_type,
                  window_start, window_end, state, attempts, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,0,?,?)
                """,
                (
                    aggregation_key,
                    session_id,
                    uid,
                    analysis_type,
                    window_start,
                    window_end,
                    "RUNNING",
                    now,
                    now,
                ),
            )
            if cursor.rowcount > 0:
                return True
            # Already exists — only retry if a previous attempt failed.
            row = conn.execute(
                "SELECT state FROM aggregations WHERE aggregation_key=?",
                (aggregation_key,),
            ).fetchone()
            if row and row["state"] == "FAILED":
                conn.execute(
                    "UPDATE aggregations SET state=?, attempts=attempts+1, updated_at=?"
                    " WHERE aggregation_key=?",
                    ("RUNNING", now, aggregation_key),
                )
                return True
            return False

    def finish_aggregation(
        self, aggregation_key: str, state: str, error: str | None = None
    ) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE aggregations SET state=?, error_message=?, updated_at=?"
                " WHERE aggregation_key=?",
                (state, error[:2000] if error else None, _now(), aggregation_key),
            )

    def completed_aggregations(self, session_id: str) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                "SELECT * FROM aggregations WHERE session_id=? AND state=? "
                "ORDER BY window_start ASC",
                (session_id, "DONE"),
            )
        )

    # ------------------------------------------------------------------
    # Meta
    # ------------------------------------------------------------------

    def set_meta(self, key: str, value: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self._conn.execute(
            "SELECT value FROM meta WHERE key=?", (key,)
        ).fetchone()
        return row["value"] if row else default


def window_key(session_id: str, window_start: datetime) -> str:
    return f"{session_id}|window|{window_start.astimezone(timezone.utc).isoformat()}"


def final_key(session_id: str) -> str:
    return f"{session_id}|final"


def window_bounds(first_chunk_at: datetime, minutes: int) -> tuple[datetime, datetime]:
    """Event-time window starting at the first unaggregated chunk.

    Deliberately not "wait for N chunks" — breaks, segment splits and dropped
    uploads all make the count unreliable.
    """
    start = first_chunk_at
    return start, start + timedelta(minutes=minutes)


def chunks_in_window(
    rows: Sequence[sqlite3.Row],
    start: datetime,
    end: datetime,
    timestamp_of,
) -> list[sqlite3.Row]:
    selected = []
    for row in rows:
        at = timestamp_of(row)
        if at is None:
            continue
        if start <= at < end:
            selected.append(row)
    return selected
