"""Representative-frame extraction from a 30s WebM chunk.

Llama-3.2-Vision takes images, not video. "Equal-scale analysis" is therefore
defined as: never re-encode or modify the source chunk, and sample frames that
are evenly spaced across the real 30 seconds at native resolution. Downscaling
only happens when the SLO forces a lighter profile, and even then it is done
inside the same ffmpeg filter graph — no intermediate MP4 is ever written.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.settings import PROFILE_SPECS

log = logging.getLogger(__name__)

# MediaRecorder WebM often carries no container duration. The app records 30s
# chunks, so this is the fallback when probing fails.
NOMINAL_CHUNK_SECONDS = 30.0


class FrameExtractionError(Exception):
    pass


@dataclass(frozen=True)
class ExtractedFrames:
    paths: list[Path]
    offsets_seconds: list[float]
    width: int
    height: int
    source_width: int
    source_height: int
    duration_seconds: float
    profile: str


def _run(args: list[str], timeout: float = 120.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout, check=False
    )


def probe(path: Path) -> tuple[float, int, int]:
    """Return (duration_seconds, width, height) for the first video stream."""
    if shutil.which("ffprobe") is None:
        raise FrameExtractionError("ffprobe not found on PATH")

    result = _run(
        [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration",
            "-show_entries", "format=duration",
            "-of", "json",
            str(path),
        ]
    )
    if result.returncode != 0:
        raise FrameExtractionError(f"ffprobe failed: {result.stderr[-500:]}")

    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams") or []
    if not streams:
        raise FrameExtractionError("no video stream found")

    stream = streams[0]
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise FrameExtractionError("could not determine frame size")

    duration = 0.0
    for candidate in (stream.get("duration"), (payload.get("format") or {}).get("duration")):
        try:
            value = float(candidate)
        except (TypeError, ValueError):
            continue
        if value > 0:
            duration = value
            break

    if duration <= 0:
        # WebM from MediaRecorder frequently reports nothing usable.
        log.debug("duration unavailable for %s; assuming %.1fs", path.name, NOMINAL_CHUNK_SECONDS)
        duration = NOMINAL_CHUNK_SECONDS

    return duration, width, height


def _even(value: int) -> int:
    """libx264/scale prefer even dimensions; keep at least 2px."""
    return max(2, value - (value % 2))


def target_size(scale: str | None, width: int, height: int) -> tuple[int, int] | None:
    """Resolve a profile's scale directive to concrete dimensions."""
    if scale is None:
        return None

    if scale == "one_third":
        return _even(width // 3), _even(height // 3)

    if scale == "720p":
        # Fit inside 1280x720 without upscaling, preserving aspect ratio.
        if width <= 1280 and height <= 720:
            return None
        ratio = min(1280 / width, 720 / height)
        return _even(int(width * ratio)), _even(int(height * ratio))

    raise FrameExtractionError(f"unknown scale directive: {scale}")


def extract_frames(source: Path, profile: str, out_dir: Path) -> ExtractedFrames:
    """Sample frames for the given profile in a single ffmpeg pass."""
    spec = PROFILE_SPECS.get(profile)
    if spec is None:
        raise FrameExtractionError(f"unknown profile: {profile}")
    frame_count = int(spec["frames"])

    if shutil.which("ffmpeg") is None:
        raise FrameExtractionError("ffmpeg not found on PATH")

    duration, source_width, source_height = probe(source)
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("frame-*.jpg"):
        stale.unlink()

    # Sample at the midpoint of each of N equal slices, so no frame sits exactly
    # on a cut and the set spans the whole chunk.
    interval = duration / frame_count
    offsets = [interval * (index + 0.5) for index in range(frame_count)]

    size = target_size(spec["scale"], source_width, source_height)
    filters = [f"fps=1/{interval:.6f}"]
    if size is not None:
        filters.append(f"scale={size[0]}:{size[1]}:flags=bicubic")

    pattern = out_dir / "frame-%03d.jpg"
    result = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-i", str(source),
            "-vf", ",".join(filters),
            "-fps_mode", "passthrough",
            "-frames:v", str(frame_count),
            "-q:v", "2",
            str(pattern),
        ],
        timeout=180.0,
    )
    if result.returncode != 0:
        raise FrameExtractionError(f"ffmpeg failed: {result.stderr[-800:]}")

    paths = sorted(out_dir.glob("frame-*.jpg"))
    if not paths:
        raise FrameExtractionError("ffmpeg produced no frames")

    # A short or truncated chunk can yield fewer frames than requested; analyse
    # what actually exists rather than padding with duplicates.
    offsets = offsets[: len(paths)]
    width, height = (size if size is not None else (source_width, source_height))

    return ExtractedFrames(
        paths=paths,
        offsets_seconds=offsets,
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        duration_seconds=duration,
        profile=profile,
    )
