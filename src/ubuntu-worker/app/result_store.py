"""GCS object paths for everything this worker writes.

Paths are always built from the uid recorded on the chunk object itself, never
from anything a client supplied. uid is never omitted.
"""

from __future__ import annotations


def session_prefix(uid: str, session_id: str) -> str:
    return f"users/{uid}/sessions/{session_id}/"


def analysis_prefix(uid: str, session_id: str) -> str:
    return f"{session_prefix(uid, session_id)}analysis/"


def status_path(uid: str, session_id: str) -> str:
    return f"{analysis_prefix(uid, session_id)}status.json"


def chunk_analysis_path(
    uid: str, session_id: str, segment_index: int, chunk_index: int
) -> str:
    return (
        f"{analysis_prefix(uid, session_id)}chunks/{segment_index}/{chunk_index}.json"
    )


def window_analysis_path(uid: str, session_id: str, window_start_iso: str) -> str:
    # Colons are legal in GCS object names but awkward in tooling; keep the ISO
    # instant intact but filesystem-friendly.
    safe = window_start_iso.replace(":", "-")
    return f"{analysis_prefix(uid, session_id)}windows/{safe}.json"


def final_analysis_path(uid: str, session_id: str) -> str:
    return f"{session_prefix(uid, session_id)}analysis.json"


def timelapse_path(uid: str, session_id: str) -> str:
    """Unchanged from the Cloud Run implementation — the UI reads this path."""
    return f"{session_prefix(uid, session_id)}timelapse.mp4"


def thumbnail_path(uid: str, session_id: str) -> str:
    return f"{session_prefix(uid, session_id)}thumbnail.jpg"
