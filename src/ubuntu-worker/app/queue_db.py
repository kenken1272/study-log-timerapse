"""Durable SQLite work queue.

Pub/Sub messages are acked as soon as they are committed here, so this file is
the only thing standing between a worker crash and a lost chunk. Everything is
written with WAL + a UNIQUE idempotency key so redelivery is a no-op.
"""

from __future__ import annotations

import random
import sqlite3
import threading
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

# An aggregation that keeps failing must eventually stop asking for a GPU.
# Counts every attempt including the first, so the ceiling is honest.
MAX_AGGREGATION_ATTEMPTS = 8
AGGREGATION_MAX_BACKOFF_SEC = 3600.0

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

# Timelapse job states.
TL_WAITING_FOR_CHUNKS = "WAITING_FOR_CHUNKS"
TL_READY = "READY"
TL_DOWNLOADING = "DOWNLOADING"
TL_ENCODING = "ENCODING"
TL_VALIDATING = "VALIDATING"
TL_UPLOADING = "UPLOADING"
TL_CALLBACK_PENDING = "CALLBACK_PENDING"
TL_COMPLETED = "COMPLETED"
TL_RETRY = "RETRY"
TL_DEAD_LETTER = "DEAD_LETTER"

# States that mean a render was in flight when the process died. On startup
# they rewind to READY: the work is repeatable and the partial output was never
# published, because output is only promoted after validation.
TL_IN_FLIGHT = (
    TL_DOWNLOADING,
    TL_ENCODING,
    TL_VALIDATING,
    TL_UPLOADING,
)

MAX_TIMELAPSE_ATTEMPTS = 5
TIMELAPSE_MAX_BACKOFF_SEC = 3600.0

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
  next_attempt_at REAL NOT NULL DEFAULT 0,
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

-- One timelapse render per session. Keyed by session_id so a duplicate trigger
-- cannot start a second render; source_fingerprint records exactly which chunk
-- generations went in, so a late or re-uploaded chunk is detectable as a
-- genuine change rather than confused with a repeat of the same work.
CREATE TABLE IF NOT EXISTS timelapse_jobs (
  session_id         TEXT PRIMARY KEY,
  uid                TEXT NOT NULL,
  state              TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    REAL NOT NULL DEFAULT 0,
  error_class        TEXT,
  error_message      TEXT,
  source_fingerprint TEXT,
  output_object      TEXT,
  thumbnail_object   TEXT,
  encoder            TEXT,
  fallback_used      INTEGER NOT NULL DEFAULT 0,
  duration_sec       REAL,
  size_bytes         INTEGER,
  chunks_used        INTEGER,
  chunks_skipped     INTEGER,
  started_at         REAL,
  completed_at       REAL,
  created_at         REAL NOT NULL,
  updated_at         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timelapse_state
  ON timelapse_jobs(state, next_attempt_at);
"""


def _now() -> float:
    return time.time()


class QueueDB:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # The connection is shared by the Pub/Sub callback threads, the chunk
        # loop and the window loop, so it must outlive its creating thread.
        # Safety comes from _lock below, not from sqlite3's own thread check.
        self._conn = sqlite3.connect(
            str(self.path), timeout=30.0, isolation_level=None, check_same_thread=False
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._migrate()
        # Reentrant: write helpers call read helpers while already holding it.
        self._lock = threading.RLock()

    def _migrate(self) -> None:
        """Additive migrations for databases created by an earlier version.

        CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
        so new columns have to be added explicitly or an upgrade in place would
        fail on live data.
        """
        columns = {
            row[1]
            for row in self._conn.execute("PRAGMA table_info(aggregations)")
        }
        if "next_attempt_at" not in columns:
            self._conn.execute(
                "ALTER TABLE aggregations ADD COLUMN next_attempt_at REAL NOT NULL DEFAULT 0"
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        """Serialised read. Every read goes through here for thread safety."""
        with self._lock:
            return list(self._conn.execute(sql, params))

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

    def requeue_without_penalty(self, key: str, reason: str) -> None:
        """Return a chunk to the queue without consuming one of its attempts.

        For failures that say nothing about the chunk — a poisoned CUDA context
        being the case that motivated this. Counting those as attempts burned
        all five retries of four healthy chunks against a dead context and
        dead-lettered work that was never broken.
        """
        now = _now()
        with self._tx() as conn:
            conn.execute(
                "UPDATE chunks SET state=?, attempts=MAX(attempts-1, 0),"
                " next_attempt_at=?, error_class=?, error_message=?, updated_at=?"
                " WHERE idempotency_key=?",
                (STATE_RECEIVED, 0, "fatal_cuda", reason[:2000], now, key),
            )
            conn.execute(
                "INSERT INTO transitions (idempotency_key, from_state, to_state, at)"
                " VALUES (?,?,?,?)",
                (key, None, STATE_RECEIVED, now),
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
        rows = self._query("SELECT * FROM chunks WHERE idempotency_key=?", (key,))
        return rows[0] if rows else None

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
        return self._query(
            """
            SELECT * FROM chunks
             WHERE session_id=? AND state=?
             ORDER BY segment_index ASC, chunk_index ASC,
                      COALESCE(gcs_time_created, '') ASC
            """,
            (session_id, STATE_COMPLETED),
        )

    def pending_count_for_session(self, session_id: str) -> int:
        rows = self._query(
            f"""
            SELECT COUNT(*) AS n FROM chunks
             WHERE session_id=? AND state NOT IN ({','.join('?' * len(TERMINAL_STATES))})
            """,
            (session_id, *TERMINAL_STATES),
        )
        return int(rows[0]["n"])

    def session_counts(self, session_id: str) -> dict[str, int]:
        rows = self._query(
            "SELECT state, COUNT(*) AS n FROM chunks WHERE session_id=? GROUP BY state",
            (session_id,),
        )
        counts = {row["state"]: int(row["n"]) for row in rows}
        counts["TOTAL"] = sum(counts.values())
        return counts

    def active_sessions(self) -> list[sqlite3.Row]:
        return self._query("SELECT * FROM sessions WHERE finalized=0")

    def mark_session_ended(self, session_id: str, ended_at: float) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sessions SET ended_at=? WHERE session_id=?",
                (ended_at, session_id),
            )

    def finalization_requested_at(self, session_id: str) -> float | None:
        """When session end was first observed, or None if it has not been."""
        rows = self._query(
            "SELECT ended_at FROM sessions WHERE session_id=?", (session_id,)
        )
        if not rows or rows[0]["ended_at"] is None:
            return None
        return float(rows[0]["ended_at"])

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
        max_attempts: int = MAX_AGGREGATION_ATTEMPTS,
    ) -> bool:
        """Reserve an aggregation unit.

        False means: already produced, currently running, still backing off, or
        given up on. The backoff and the ceiling both matter — without them a
        failing window retried every 60s forever, loading a 12B model each time.
        """
        now = _now()
        with self._tx() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO aggregations (
                  aggregation_key, session_id, uid, analysis_type,
                  window_start, window_end, state, attempts,
                  next_attempt_at, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,1,0,?,?)
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

            row = conn.execute(
                "SELECT state, attempts, next_attempt_at FROM aggregations"
                " WHERE aggregation_key=?",
                (aggregation_key,),
            ).fetchone()
            if row is None:
                return False
            if row["state"] not in ("FAILED", "WAITING_FOR_CHUNKS"):
                return False
            if (row["next_attempt_at"] or 0) > now:
                return False
            if row["attempts"] >= max_attempts:
                if row["state"] != "DEAD_LETTER":
                    conn.execute(
                        "UPDATE aggregations SET state=?, updated_at=?"
                        " WHERE aggregation_key=?",
                        ("DEAD_LETTER", now, aggregation_key),
                    )
                return False

            conn.execute(
                "UPDATE aggregations SET state=?, attempts=attempts+1, updated_at=?"
                " WHERE aggregation_key=?",
                ("RUNNING", now, aggregation_key),
            )
            return True

    def defer_aggregation(self, aggregation_key: str, state: str, reason: str) -> None:
        """Park an aggregation with exponential backoff instead of hot-looping."""
        now = _now()
        row = self._query(
            "SELECT attempts FROM aggregations WHERE aggregation_key=?",
            (aggregation_key,),
        )
        attempts = row[0]["attempts"] if row else 0
        delay = min(60.0 * (2 ** min(attempts, 6)), AGGREGATION_MAX_BACKOFF_SEC)
        delay = random.uniform(delay / 2, delay)
        with self._tx() as conn:
            conn.execute(
                "UPDATE aggregations SET state=?, error_message=?, next_attempt_at=?,"
                " updated_at=? WHERE aggregation_key=?",
                (state, reason[:2000], now + delay, now, aggregation_key),
            )

    def finish_aggregation(
        self, aggregation_key: str, state: str, error: str | None = None
    ) -> None:
        now = _now()
        next_attempt = 0.0
        if state == "FAILED":
            row = self._query(
                "SELECT attempts FROM aggregations WHERE aggregation_key=?",
                (aggregation_key,),
            )
            attempts = row[0]["attempts"] if row else 0
            delay = min(60.0 * (2 ** min(attempts, 6)), AGGREGATION_MAX_BACKOFF_SEC)
            next_attempt = now + random.uniform(delay / 2, delay)
        with self._tx() as conn:
            conn.execute(
                "UPDATE aggregations SET state=?, error_message=?, next_attempt_at=?,"
                " updated_at=? WHERE aggregation_key=?",
                (state, error[:2000] if error else None, next_attempt, now,
                 aggregation_key),
            )

    def completed_aggregations(self, session_id: str) -> list[sqlite3.Row]:
        return self._query(
            "SELECT * FROM aggregations WHERE session_id=? AND state=? "
            "ORDER BY window_start ASC",
            (session_id, "DONE"),
        )

    # ------------------------------------------------------------------
    # Timelapse jobs
    # ------------------------------------------------------------------

    def upsert_timelapse_job(self, session_id: str, uid: str, state: str) -> bool:
        """Create the job if absent. Returns True when it was created."""
        now = _now()
        with self._tx() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO timelapse_jobs (session_id, uid, state,"
                " created_at, updated_at) VALUES (?,?,?,?,?)",
                (session_id, uid, state, now, now),
            )
            return cursor.rowcount > 0

    def get_timelapse_job(self, session_id: str):
        rows = self._query(
            "SELECT * FROM timelapse_jobs WHERE session_id=?", (session_id,)
        )
        return rows[0] if rows else None

    def set_timelapse_state(self, session_id: str, state: str, **fields) -> None:
        assignments = ["state=?", "updated_at=?"]
        values: list[object] = [state, _now()]
        for name, value in fields.items():
            assignments.append(f"{name}=?")
            values.append(value)
        values.append(session_id)
        with self._tx() as conn:
            conn.execute(
                f"UPDATE timelapse_jobs SET {', '.join(assignments)} WHERE session_id=?",
                values,
            )

    def claim_timelapse_job(self, session_id: str) -> bool:
        """Take exclusive ownership of a render.

        False means: already running, already completed, still backing off, or
        given up on. Only one render runs at a time across the whole worker —
        see claim_any_timelapse_job.
        """
        now = _now()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT state, attempts, next_attempt_at FROM timelapse_jobs"
                " WHERE session_id=?",
                (session_id,),
            ).fetchone()
            if row is None:
                return False
            if row["state"] not in (TL_READY, TL_RETRY, TL_WAITING_FOR_CHUNKS):
                return False
            if (row["next_attempt_at"] or 0) > now:
                return False
            if row["attempts"] >= MAX_TIMELAPSE_ATTEMPTS:
                conn.execute(
                    "UPDATE timelapse_jobs SET state=?, updated_at=? WHERE session_id=?",
                    (TL_DEAD_LETTER, now, session_id),
                )
                return False
            conn.execute(
                "UPDATE timelapse_jobs SET state=?, attempts=attempts+1,"
                " started_at=?, updated_at=? WHERE session_id=?",
                (TL_DOWNLOADING, now, now, session_id),
            )
            return True

    def timelapse_job_in_progress(self) -> bool:
        """True when any render holds the single concurrency slot."""
        placeholders = ",".join("?" * len(TL_IN_FLIGHT))
        rows = self._query(
            f"SELECT 1 FROM timelapse_jobs WHERE state IN ({placeholders}) LIMIT 1",
            TL_IN_FLIGHT,
        )
        return bool(rows)

    def timelapse_jobs_awaiting(self) -> list:
        """Jobs that want attention, oldest first."""
        now = _now()
        return self._query(
            "SELECT * FROM timelapse_jobs WHERE state IN (?,?,?,?)"
            " AND next_attempt_at <= ? ORDER BY created_at ASC",
            (TL_WAITING_FOR_CHUNKS, TL_READY, TL_RETRY, TL_CALLBACK_PENDING, now),
        )

    def fail_timelapse_job(
        self, session_id: str, error_class: str, message: str
    ) -> str:
        """Back off, or give up once the ceiling is reached."""
        row = self.get_timelapse_job(session_id)
        attempts = row["attempts"] if row else MAX_TIMELAPSE_ATTEMPTS
        if attempts >= MAX_TIMELAPSE_ATTEMPTS:
            self.set_timelapse_state(
                session_id, TL_DEAD_LETTER,
                error_class=error_class, error_message=message[:2000],
            )
            return TL_DEAD_LETTER

        delay = min(60.0 * (2 ** min(attempts, 6)), TIMELAPSE_MAX_BACKOFF_SEC)
        self.set_timelapse_state(
            session_id, TL_RETRY,
            error_class=error_class,
            error_message=message[:2000],
            next_attempt_at=_now() + random.uniform(delay / 2, delay),
        )
        return TL_RETRY

    def recover_timelapse_jobs(self) -> int:
        """Rewind renders abandoned by a previous process.

        Safe because output is only published after validation, so an
        interrupted render left nothing behind that anyone can see.
        """
        now = _now()
        placeholders = ",".join("?" * len(TL_IN_FLIGHT))
        with self._tx() as conn:
            cursor = conn.execute(
                f"UPDATE timelapse_jobs SET state=?, next_attempt_at=0, updated_at=?"
                f" WHERE state IN ({placeholders})",
                (TL_READY, now, *TL_IN_FLIGHT),
            )
            return cursor.rowcount

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
        rows = self._query("SELECT value FROM meta WHERE key=?", (key,))
        return rows[0]["value"] if rows else default


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
