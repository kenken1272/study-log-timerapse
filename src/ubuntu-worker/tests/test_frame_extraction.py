"""Frame sampling against real ffmpeg.

Skipped automatically where ffmpeg is unavailable, so the suite still runs on a
bare checkout.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.video_frames import (
    FrameExtractionError,
    extract_frames,
    probe,
    target_size,
)

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


@pytest.fixture(scope="module")
def chunk(tmp_path_factory) -> Path:
    """A synthetic 30s 1080p WebM standing in for a recorded chunk."""
    path = tmp_path_factory.mktemp("video") / "chunk.webm"
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=30",
            "-c:v", "libvpx-vp9", "-b:v", "500k",
            "-deadline", "realtime", "-cpu-used", "8",
            str(path),
        ],
        check=True,
    )
    return path


def test_probe_reads_duration_and_size(chunk):
    duration, width, height = probe(chunk)
    assert duration == pytest.approx(30.0, abs=0.5)
    assert (width, height) == (1920, 1080)


def test_default_profile_keeps_native_resolution(chunk, tmp_path):
    frames = extract_frames(chunk, "original_8", tmp_path / "out")
    assert len(frames.paths) == 8
    assert (frames.width, frames.height) == (1920, 1080)
    assert frames.source_width == 1920


def test_frames_are_evenly_spaced_across_the_chunk(chunk, tmp_path):
    frames = extract_frames(chunk, "original_8", tmp_path / "out")
    gaps = [
        round(b - a, 2)
        for a, b in zip(frames.offsets_seconds, frames.offsets_seconds[1:])
    ]
    assert len(set(gaps)) == 1
    # Samples sit inside the chunk, never on its edges.
    assert frames.offsets_seconds[0] > 0
    assert frames.offsets_seconds[-1] < frames.duration_seconds


@pytest.mark.parametrize(
    "profile,expected_size,expected_count",
    [
        ("original_8", (1920, 1080), 8),
        ("reduced_720p_8", (1280, 720), 8),
        ("one_third_8", (640, 360), 8),
        ("one_third_6", (640, 360), 6),
    ],
)
def test_every_profile_produces_its_declared_output(
    chunk, tmp_path, profile, expected_size, expected_count
):
    frames = extract_frames(chunk, profile, tmp_path / profile)
    assert len(frames.paths) == expected_count
    assert (frames.width, frames.height) == expected_size
    assert all(path.stat().st_size > 0 for path in frames.paths)


def test_source_chunk_is_never_modified(chunk, tmp_path):
    before = (chunk.stat().st_size, chunk.stat().st_mtime)
    extract_frames(chunk, "one_third_8", tmp_path / "out")
    assert (chunk.stat().st_size, chunk.stat().st_mtime) == before


def test_no_intermediate_video_is_written(chunk, tmp_path):
    out = tmp_path / "out"
    extract_frames(chunk, "one_third_8", out)
    # Only JPEG stills — a re-encoded MP4 here would break the "no re-encode" rule.
    assert {path.suffix for path in out.iterdir()} == {".jpg"}


def test_rerunning_clears_stale_frames(chunk, tmp_path):
    out = tmp_path / "out"
    extract_frames(chunk, "original_8", out)
    frames = extract_frames(chunk, "one_third_6", out)
    assert len(list(out.glob("frame-*.jpg"))) == 6
    assert len(frames.paths) == 6


def test_unknown_profile_is_rejected(chunk, tmp_path):
    with pytest.raises(FrameExtractionError):
        extract_frames(chunk, "does_not_exist", tmp_path / "out")


def test_corrupt_input_raises_rather_than_returning_nothing(tmp_path):
    broken = tmp_path / "broken.webm"
    broken.write_bytes(b"not a video")
    with pytest.raises(FrameExtractionError):
        extract_frames(broken, "original_8", tmp_path / "out")


def test_720p_profile_never_upscales():
    # A 640x480 source stays as-is rather than being blown up to 1280x960.
    assert target_size("720p", 640, 480) is None


def test_scale_targets_are_even():
    width, height = target_size("one_third", 1921, 1081)
    assert width % 2 == 0 and height % 2 == 0
