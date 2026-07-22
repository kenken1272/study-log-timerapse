"""Deciding when a session's timelapse may be rendered.

Rendering early is worse than rendering late: a timelapse missing its last two
minutes looks finished but is wrong, and the user has no way to tell. So this
is a gate with several independent conditions rather than a timer, and it
refuses whenever it cannot prove the source is complete.

"60 seconds after the end" alone is not enough. The end signal (metadata.json)
travels a different path from the chunk notifications and routinely arrives
first, and a chunk that is still uploading has no presence in either.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

log = logging.getLogger(__name__)

# Minimum settle time after session end is first observed.
MIN_SETTLE_SEC = 60.0

# How long the GCS listing must be unchanged before it counts as stable. Used
# as the primary signal when metadata carries no chunk count.
LISTING_STABLE_SEC = 60.0

# Chunk states that mean the VLM is not finished with a chunk yet.
NON_TERMINAL_CHUNK_STATES = (
    "RECEIVED",
    "DOWNLOADING",
    "DOWNLOADED",
    "EXTRACTING",
    "VLM_RUNNING",
    "VLM_DONE",
    "UPLOADING",
    "RETRY_WAIT",
)


@dataclass
class ReadinessResult:
    ready: bool
    reason: str
    warnings: list[str]
    expected_chunk_count: int | None = None
    observed_chunk_count: int = 0


@dataclass
class ListingObservation:
    """A remembered GCS listing, used to detect that uploads have stopped."""

    signature: str
    first_seen_at: float


class ListingTracker:
    """Remembers each session's last chunk listing and when it last changed."""

    def __init__(self) -> None:
        self._observations: dict[str, ListingObservation] = {}

    def observe(self, session_id: str, object_names: list[str], now: float | None = None) -> float:
        """Record a listing; return how long it has been unchanged, in seconds."""
        now = now if now is not None else time.time()
        signature = "|".join(sorted(object_names))
        previous = self._observations.get(session_id)
        if previous is None or previous.signature != signature:
            self._observations[session_id] = ListingObservation(signature, now)
            return 0.0
        return now - previous.first_seen_at

    def forget(self, session_id: str) -> None:
        self._observations.pop(session_id, None)


def evaluate_readiness(
    *,
    ended_at: float | None,
    now: float,
    chunk_states: dict[str, int],
    observed_chunk_slots: int,
    expected_chunk_count: int | None,
    listing_stable_for_sec: float,
) -> ReadinessResult:
    """Decide whether a render may start.

    `chunk_states` is a state -> count map for this session's chunks.
    `observed_chunk_slots` counts distinct (segment, chunk) slots seen in GCS,
    not database rows, because a re-uploaded slot must not inflate the total.
    """
    warnings: list[str] = []

    if ended_at is None:
        return ReadinessResult(False, "session has not ended", warnings)

    waited = now - ended_at
    if waited < MIN_SETTLE_SEC:
        return ReadinessResult(
            False,
            f"waiting out the settle period ({waited:.0f}s of {MIN_SETTLE_SEC:.0f}s)",
            warnings,
        )

    # Every chunk must have reached a terminal state. A chunk still in VLM
    # analysis may yet produce a result, and more importantly its presence
    # means the pipeline is still moving.
    in_flight = sum(chunk_states.get(state, 0) for state in NON_TERMINAL_CHUNK_STATES)
    if in_flight:
        return ReadinessResult(
            False, f"{in_flight} chunk(s) still being analysed", warnings,
            expected_chunk_count, observed_chunk_slots,
        )

    completed = chunk_states.get("COMPLETED", 0)
    dead_lettered = chunk_states.get("DEAD_LETTER", 0)
    terminal = completed + dead_lettered

    if terminal == 0:
        return ReadinessResult(
            False, "no chunks have finished analysis", warnings,
            expected_chunk_count, observed_chunk_slots,
        )

    if expected_chunk_count is not None:
        if terminal < expected_chunk_count:
            return ReadinessResult(
                False,
                f"only {terminal} of {expected_chunk_count} expected chunks are terminal",
                warnings, expected_chunk_count, observed_chunk_slots,
            )
        if observed_chunk_slots < expected_chunk_count:
            return ReadinessResult(
                False,
                f"GCS holds {observed_chunk_slots} chunk slots, "
                f"metadata expects {expected_chunk_count}",
                warnings, expected_chunk_count, observed_chunk_slots,
            )
        if observed_chunk_slots > expected_chunk_count:
            # More is not a reason to refuse — a resumed recording can add
            # segments — but the mismatch is worth recording.
            warnings.append(
                f"GCS holds {observed_chunk_slots} chunk slots but metadata "
                f"expects {expected_chunk_count}; rendering everything present"
            )
    else:
        # Without a declared count, a quiet listing is the only evidence that
        # uploads have finished. Weaker, so it is flagged.
        warnings.append(
            "metadata has no chunkCount; relying on the GCS listing being stable"
        )
        if listing_stable_for_sec < LISTING_STABLE_SEC:
            return ReadinessResult(
                False,
                f"chunk listing has only been stable for {listing_stable_for_sec:.0f}s "
                f"of {LISTING_STABLE_SEC:.0f}s",
                warnings, expected_chunk_count, observed_chunk_slots,
            )

    if dead_lettered:
        # Analysis failing does not stop the render — the source video is
        # still there — but it must be visible, not quietly absorbed.
        warnings.append(
            f"{dead_lettered} chunk(s) failed analysis; the timelapse will still "
            "be rendered from the source video"
        )

    return ReadinessResult(
        True, "ready", warnings, expected_chunk_count, observed_chunk_slots
    )
