"""When a timelapse may start.

Rendering early produces a video that looks finished but silently omits the end
of the session, which the user cannot detect. Every condition here exists to
make that impossible.
"""

from __future__ import annotations

import pytest

from app.timelapse_trigger import (
    LISTING_STABLE_SEC,
    MIN_SETTLE_SEC,
    ListingTracker,
    evaluate_readiness,
)

TERMINAL_4 = {"COMPLETED": 4}


def check(**overrides):
    kwargs = dict(
        ended_at=1000.0,
        now=1000.0 + MIN_SETTLE_SEC + 1,
        chunk_states=dict(TERMINAL_4),
        observed_chunk_slots=4,
        expected_chunk_count=4,
        listing_stable_for_sec=LISTING_STABLE_SEC + 1,
    )
    kwargs.update(overrides)
    return evaluate_readiness(**kwargs)


def test_ready_when_everything_lines_up():
    assert check().ready is True


def test_never_starts_before_the_session_ends():
    result = check(ended_at=None)
    assert result.ready is False
    assert "not ended" in result.reason


def test_waits_out_the_settle_period():
    result = check(now=1000.0 + MIN_SETTLE_SEC - 1)
    assert result.ready is False
    assert "settle" in result.reason


def test_starts_once_the_settle_period_has_passed():
    assert check(now=1000.0 + MIN_SETTLE_SEC + 0.1).ready is True


@pytest.mark.parametrize(
    "state",
    ["RECEIVED", "EXTRACTING", "VLM_RUNNING", "UPLOADING", "RETRY_WAIT"],
)
def test_waits_while_any_chunk_is_still_being_analysed(state):
    result = check(chunk_states={"COMPLETED": 3, state: 1})
    assert result.ready is False
    assert "still being analysed" in result.reason


def test_waits_when_fewer_chunks_are_terminal_than_expected():
    result = check(chunk_states={"COMPLETED": 2}, expected_chunk_count=4)
    assert result.ready is False
    assert "2 of 4" in result.reason


def test_waits_when_gcs_holds_fewer_slots_than_metadata_expects():
    # The analysis DB can be complete while an upload is still missing.
    result = check(observed_chunk_slots=3, expected_chunk_count=4)
    assert result.ready is False
    assert "GCS holds 3" in result.reason


def test_extra_slots_warn_but_do_not_block():
    # A resumed recording legitimately adds segments.
    result = check(observed_chunk_slots=6, expected_chunk_count=4)
    assert result.ready is True
    assert any("6 chunk slots" in w for w in result.warnings)


def test_dead_lettered_analysis_does_not_block_the_render():
    """The source video exists even when its analysis failed."""
    result = check(chunk_states={"COMPLETED": 2, "DEAD_LETTER": 2})
    assert result.ready is True
    assert any("failed analysis" in w for w in result.warnings)


def test_analysis_failure_is_never_silent():
    result = check(chunk_states={"COMPLETED": 3, "DEAD_LETTER": 1})
    assert result.warnings, "a dead-lettered chunk must produce a warning"


def test_refuses_when_nothing_finished_at_all():
    result = check(chunk_states={})
    assert result.ready is False
    assert "no chunks" in result.reason


# --- fallback when metadata carries no chunk count ---

def test_without_chunk_count_waits_for_a_stable_listing():
    result = check(
        expected_chunk_count=None, listing_stable_for_sec=LISTING_STABLE_SEC - 5
    )
    assert result.ready is False
    assert "stable" in result.reason


def test_without_chunk_count_proceeds_once_the_listing_settles():
    result = check(
        expected_chunk_count=None, listing_stable_for_sec=LISTING_STABLE_SEC + 1
    )
    assert result.ready is True


def test_missing_chunk_count_is_always_warned_about():
    # A weaker signal than a declared count, so it must be visible in the logs.
    result = check(expected_chunk_count=None)
    assert any("no chunkCount" in w for w in result.warnings)


# --- listing tracker ---

def test_tracker_reports_zero_when_the_listing_changes():
    tracker = ListingTracker()
    assert tracker.observe("s", ["a", "b"], now=100.0) == 0.0
    # Unchanged: the clock runs.
    assert tracker.observe("s", ["b", "a"], now=130.0) == 30.0
    # A new chunk resets it.
    assert tracker.observe("s", ["a", "b", "c"], now=140.0) == 0.0


def test_tracker_is_order_insensitive():
    tracker = ListingTracker()
    tracker.observe("s", ["b", "a"], now=0.0)
    assert tracker.observe("s", ["a", "b"], now=50.0) == 50.0


def test_tracker_separates_sessions():
    tracker = ListingTracker()
    tracker.observe("s1", ["a"], now=0.0)
    assert tracker.observe("s2", ["a"], now=100.0) == 0.0
    assert tracker.observe("s1", ["a"], now=100.0) == 100.0


def test_a_late_chunk_resets_the_stability_clock():
    """The exact hazard: a chunk arriving after the settle period."""
    tracker = ListingTracker()
    tracker.observe("s", ["c0", "c1"], now=0.0)
    assert tracker.observe("s", ["c0", "c1"], now=59.0) == 59.0
    # Late arrival at t=59 — not ready again until it too has settled.
    assert tracker.observe("s", ["c0", "c1", "c2"], now=59.5) == 0.0
    result = check(expected_chunk_count=None, listing_stable_for_sec=0.0)
    assert result.ready is False
