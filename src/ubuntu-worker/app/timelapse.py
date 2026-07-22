"""Timelapse rendering, moved off Cloud Run onto this host.

Produces byte-for-byte-compatible output with the Cloud Run implementation it
replaces (`src/lib/video/processTimelapse.ts`): H.264, 30fps, 1280 wide,
aspect preserved, no audio, yuv420p, faststart, plus a 960-wide JPEG thumbnail.
The GCS paths and Firestore fields are unchanged, so the web UI needs no
knowledge that rendering moved.

Three properties of the real data drove the design here, all observed in
production rather than assumed:

* **Chunk slots repeat.** 25 (session, segment, chunk) slots in the live
  database have two or three rows with different GCS generations, from
  re-uploads. Concatenating every row would duplicate footage, so the timeline
  is deduplicated to one generation per slot.
* **Some chunks are truncated.** 20 chunks fail ffprobe with "invalid as first
  byte of an EBML number ... End of file" — uploads that were cut short. Handing
  those to concat corrupts or aborts the whole render, so every chunk is probed
  first and unreadable ones are skipped and counted.
* **Decode dominates, not encode.** See ENCODER_NOTES below.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# Output contract, matched to the Cloud Run implementation being replaced.
OUTPUT_WIDTH = 1280
OUTPUT_FPS = 30
THUMBNAIL_WIDTH = 960
THUMBNAIL_QUALITY = "3"  # ffmpeg -q:v 3, as Cloud Run used

# Duration tolerance. setpts + fps resampling rounds to whole frames, and each
# chunk contributes its own rounding, so the allowance grows with chunk count.
DURATION_TOLERANCE_BASE_SEC = 2.0
DURATION_TOLERANCE_PER_CHUNK_SEC = 0.05

FFMPEG_TIMEOUT_BASE_SEC = 300.0
FFMPEG_TIMEOUT_PER_CHUNK_SEC = 5.0
FFPROBE_TIMEOUT_SEC = 30.0

# Keep only the tail of ffmpeg's output: enough to diagnose, bounded so a
# pathological run cannot fill the database.
MAX_CAPTURED_STDERR = 4000


class TimelapseError(Exception):
    """Rendering failed in a way worth retrying."""


class TimelapseFatal(Exception):
    """Rendering cannot succeed for this input however many times it is tried."""


@dataclass
class SourceChunk:
    """One chunk that will contribute to the timelapse."""

    object_name: str
    generation: str
    segment_index: int
    chunk_index: int
    local_path: Path | None = None
    duration_sec: float = 0.0
    readable: bool = False


@dataclass
class RenderResult:
    video_path: Path
    thumbnail_path: Path
    duration_sec: float
    size_bytes: int
    width: int
    height: int
    encoder: str
    fallback_used: bool
    fallback_reason: str | None
    chunks_used: int
    chunks_skipped: int
    download_ms: int = 0
    encode_ms: int = 0
    thumbnail_ms: int = 0
    probe_ms: int = 0
    warnings: list[str] = field(default_factory=list)


def auto_timelapse_speed(actual_study_sec: float) -> int:
    """Port of getAutoTimelapseSpeed from src/lib/sessions/firestore.ts.

    Must stay identical to the TypeScript version or a session rendered here
    would run at a different speed from one rendered on Cloud Run.
    """
    if actual_study_sec < 45 * 60:
        return 30
    if actual_study_sec < 120 * 60:
        return 60
    return 120


def dedupe_and_sort(chunks: list[SourceChunk]) -> tuple[list[SourceChunk], list[str]]:
    """One chunk per (segment, chunk) slot, in timeline order.

    Ordering is (segment_index, chunk_index) because each recording segment
    restarts chunk_index at zero. Where a slot repeats, the highest generation
    wins: GCS generations increase monotonically, so that is the most recent
    upload — the earlier one is a superseded partial or retry.
    """
    warnings: list[str] = []
    by_slot: dict[tuple[int, int], SourceChunk] = {}

    for chunk in chunks:
        slot = (chunk.segment_index, chunk.chunk_index)
        existing = by_slot.get(slot)
        if existing is None:
            by_slot[slot] = chunk
            continue
        # Generations are numeric strings; compare as integers so "10" > "9".
        if int(chunk.generation) > int(existing.generation):
            by_slot[slot] = chunk
        warnings.append(
            f"segment {slot[0]} chunk {slot[1]} had multiple uploads; "
            f"using generation {by_slot[slot].generation}"
        )

    ordered = sorted(by_slot.values(), key=lambda c: (c.segment_index, c.chunk_index))

    # Report gaps per segment. A gap is not fatal — the user may have paused —
    # but it must never be silent.
    for segment in sorted({c.segment_index for c in ordered}):
        indices = [c.chunk_index for c in ordered if c.segment_index == segment]
        expected = set(range(min(indices), max(indices) + 1))
        missing = sorted(expected - set(indices))
        if missing:
            warnings.append(
                f"segment {segment} is missing chunk indices {missing[:10]}"
                + (" (truncated)" if len(missing) > 10 else "")
            )

    return ordered, warnings


def source_fingerprint(chunks: list[SourceChunk]) -> str:
    """Identify exactly this set of source objects at these generations.

    A late upload or a re-upload changes the fingerprint, which is how a
    completed render is told apart from one that needs redoing.
    """
    digest = hashlib.sha256()
    for chunk in sorted(chunks, key=lambda c: (c.segment_index, c.chunk_index)):
        digest.update(f"{chunk.object_name}#{chunk.generation}\n".encode())
    return digest.hexdigest()


def _run(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    """Run a child process in its own group, never through a shell.

    Object names come from GCS and reach these arguments, so they are passed as
    a list and never interpolated into a command line. start_new_session gives
    the child its own process group, so a timeout kills ffmpeg's own children
    too rather than orphaning them on the GPU.
    """
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_group(process)
        raise TimelapseError(f"{args[0]} exceeded {timeout:.0f}s") from None
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def _terminate_group(process: subprocess.Popen, grace: float = 10.0) -> None:
    import signal

    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        process.terminate()
    try:
        process.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()
    process.wait(timeout=5)


def probe_chunk(path: Path) -> tuple[bool, float]:
    """Return (readable, duration). Truncated uploads are common — see module doc."""
    result = _run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        timeout=FFPROBE_TIMEOUT_SEC,
    )
    if result.returncode != 0:
        return False, 0.0
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return False, 0.0
    if not payload.get("streams"):
        return False, 0.0
    try:
        duration = float((payload.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    # A chunk with no readable duration still concatenates fine; only a missing
    # video stream or a non-zero ffprobe exit means it is unusable.
    return True, duration


def write_concat_file(chunks: list[SourceChunk], destination: Path) -> None:
    """Write an ffmpeg concat list, quoting paths the way ffmpeg expects.

    ffmpeg's concat demuxer takes single quotes, escaping an embedded quote as
    '\\''. Paths here are worker-generated, but they are escaped anyway rather
    than relying on that.
    """
    lines = []
    for chunk in chunks:
        path = str(chunk.local_path)
        escaped = path.replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


# Measured on this host with real 1280x720 VP8 chunks, comparing the production
# libx264 settings against h264_nvenc on GPU0. See docs/ubuntu-benchmark-results.md.
#
# The workload is dominated by **VP8 decode**, not H.264 encode: `setpts` makes
# ffmpeg decode every input frame and then drop most of them, so a 3-hour
# session decodes ~324k frames to emit ~2.7k. NVENC accelerates only the part
# that was never the bottleneck, and at cq28 it produced a file 2.3x larger
# than libx264 at crf28 for identical stream properties.
#
# libx264 is therefore the default. NVENC stays available behind
# TIMELAPSE_ENCODER=h264_nvenc because on a busy host it trades CPU for GPU,
# and the VLM's 25s SLO is a CPU-sensitive neighbour.
ENCODER_NOTES = "libx264 default; NVENC opt-in (decode-bound workload)"


def encoder_args(encoder: str) -> list[str]:
    """Codec arguments. Quality is matched to the Cloud Run output."""
    if encoder == "h264_nvenc":
        return [
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", "28",
            "-b:v", "0",
        ]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]


def build_ffmpeg_args(
    concat_file: Path, output: Path, speed: int, encoder: str, gpu_index: int | None
) -> list[str]:
    """The exact command used to render. Kept in one place so it is testable."""
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    args += ["-f", "concat", "-safe", "0", "-i", str(concat_file)]
    # Identical filter chain to the Cloud Run version: speed up, resample to a
    # constant 30fps, scale to 1280 wide with an even height (-2).
    args += ["-filter:v", f"setpts=PTS/{speed},fps={OUTPUT_FPS},scale={OUTPUT_WIDTH}:-2"]
    args += ["-an"]
    args += encoder_args(encoder)
    if encoder == "h264_nvenc" and gpu_index is not None:
        args += ["-gpu", str(gpu_index)]
    args += ["-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    return args


def build_thumbnail_args(video: Path, output: Path) -> list[str]:
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", "0", "-i", str(video),
        "-frames:v", "1",
        "-vf", f"scale={THUMBNAIL_WIDTH}:-2",
        "-q:v", THUMBNAIL_QUALITY,
        str(output),
    ]


def probe_output(path: Path) -> dict:
    """Read back what was actually produced, for validation."""
    result = _run(
        [
            "ffprobe", "-v", "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate",
            "-show_entries", "format=duration,size",
            "-of", "json", str(path),
        ],
        timeout=FFPROBE_TIMEOUT_SEC,
    )
    if result.returncode != 0:
        raise TimelapseError(f"ffprobe failed on output: {result.stderr[-400:]}")
    return json.loads(result.stdout or "{}")


def validate_output(path: Path, expected_duration_sec: float, chunk_count: int) -> dict:
    """Refuse to publish a file that is not a playable timelapse.

    Everything here has been a real failure mode somewhere: a zero-byte file
    from a killed ffmpeg, an odd height that some decoders reject, a stream
    that is not actually h264, or a duration far from what the inputs imply
    (which means chunks were silently dropped).
    """
    if not path.exists() or path.stat().st_size == 0:
        raise TimelapseError("output file is missing or empty")

    payload = probe_output(path)
    streams = payload.get("streams") or []
    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]

    if len(video) < 1:
        raise TimelapseError("output has no video stream")
    if audio:
        raise TimelapseError(f"output unexpectedly has {len(audio)} audio stream(s)")

    stream = video[0]
    if stream.get("codec_name") != "h264":
        raise TimelapseError(f"output codec is {stream.get('codec_name')}, expected h264")
    if int(stream.get("width") or 0) != OUTPUT_WIDTH:
        raise TimelapseError(f"output width is {stream.get('width')}, expected {OUTPUT_WIDTH}")
    height = int(stream.get("height") or 0)
    if height <= 0 or height % 2 != 0:
        raise TimelapseError(f"output height {height} is not a positive even number")
    if stream.get("pix_fmt") != "yuv420p":
        raise TimelapseError(f"output pix_fmt is {stream.get('pix_fmt')}, expected yuv420p")

    rate = stream.get("avg_frame_rate") or "0/0"
    try:
        numerator, _, denominator = rate.partition("/")
        fps = float(numerator) / float(denominator) if float(denominator) else 0.0
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    if abs(fps - OUTPUT_FPS) > 1.0:
        raise TimelapseError(f"output frame rate {fps:.2f} is not ~{OUTPUT_FPS}")

    duration = float((payload.get("format") or {}).get("duration") or 0.0)
    if duration <= 0:
        raise TimelapseError("output duration is zero")

    if expected_duration_sec > 0:
        tolerance = (
            DURATION_TOLERANCE_BASE_SEC
            + DURATION_TOLERANCE_PER_CHUNK_SEC * max(chunk_count, 0)
        )
        if abs(duration - expected_duration_sec) > tolerance:
            raise TimelapseError(
                f"output duration {duration:.2f}s differs from expected "
                f"{expected_duration_sec:.2f}s by more than {tolerance:.2f}s "
                "— chunks were probably dropped"
            )

    return {
        "duration_sec": duration,
        "width": int(stream.get("width")),
        "height": height,
        "size_bytes": path.stat().st_size,
    }


def validate_thumbnail(path: Path) -> None:
    if not path.exists() or path.stat().st_size == 0:
        raise TimelapseError("thumbnail is missing or empty")
    payload = probe_output(path)
    streams = payload.get("streams") or []
    if not streams:
        raise TimelapseError("thumbnail has no image stream")
    width = int(streams[0].get("width") or 0)
    if width != THUMBNAIL_WIDTH:
        raise TimelapseError(f"thumbnail width {width}, expected {THUMBNAIL_WIDTH}")


def free_disk_bytes(path: Path) -> int:
    usage = shutil.disk_usage(path)
    return usage.free


def render(
    chunks: list[SourceChunk],
    work_dir: Path,
    speed: int,
    encoder: str = "libx264",
    gpu_index: int | None = None,
    allow_fallback: bool = True,
) -> RenderResult:
    """Render a timelapse from already-downloaded chunks.

    Downloading is the caller's job so that this stays testable and so the
    caller can stream chunks to disk one at a time rather than holding a
    three-hour session in memory.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(work_dir, 0o700)

    warnings: list[str] = []

    # --- probe every chunk; skip the unreadable ---
    probe_started = time.perf_counter()
    usable: list[SourceChunk] = []
    for chunk in chunks:
        if chunk.local_path is None or not chunk.local_path.exists():
            warnings.append(
                f"segment {chunk.segment_index} chunk {chunk.chunk_index} was not downloaded"
            )
            continue
        readable, duration = probe_chunk(chunk.local_path)
        chunk.readable = readable
        chunk.duration_sec = duration
        if readable:
            usable.append(chunk)
        else:
            warnings.append(
                f"segment {chunk.segment_index} chunk {chunk.chunk_index} is unreadable "
                "(truncated upload); skipped"
            )
    probe_ms = int((time.perf_counter() - probe_started) * 1000)

    if not usable:
        # Nothing to render, and retrying will not change that.
        raise TimelapseFatal("no readable chunks")

    concat_file = work_dir / "files.txt"
    write_concat_file(usable, concat_file)

    total_source_sec = sum(c.duration_sec for c in usable)
    expected_duration = total_source_sec / speed if speed else 0.0

    # Render to a temporary name; it becomes the real output only after it has
    # been validated, so a killed ffmpeg cannot leave something publishable.
    temp_output = work_dir / "timelapse.partial.mp4"
    final_output = work_dir / "timelapse.mp4"
    timeout = FFMPEG_TIMEOUT_BASE_SEC + FFMPEG_TIMEOUT_PER_CHUNK_SEC * len(usable)

    fallback_used = False
    fallback_reason: str | None = None
    chosen = encoder

    encode_started = time.perf_counter()
    result = _run(build_ffmpeg_args(concat_file, temp_output, speed, chosen, gpu_index), timeout)

    if result.returncode != 0 and chosen == "h264_nvenc" and allow_fallback:
        # NVENC can fail for reasons unrelated to the input: all encoder
        # sessions busy, or the driver refusing a concurrent session. libx264
        # produces the same stream properties, so falling back is safe.
        fallback_reason = f"h264_nvenc failed: {result.stderr.strip()[-300:]}"
        log.warning("NVENC failed, falling back to libx264: %s", fallback_reason)
        fallback_used = True
        chosen = "libx264"
        temp_output.unlink(missing_ok=True)
        result = _run(
            build_ffmpeg_args(concat_file, temp_output, speed, chosen, None), timeout
        )

    encode_ms = int((time.perf_counter() - encode_started) * 1000)

    if result.returncode != 0:
        raise TimelapseError(
            f"ffmpeg exited {result.returncode}: {result.stderr.strip()[-MAX_CAPTURED_STDERR:]}"
        )

    metrics = validate_output(temp_output, expected_duration, len(usable))

    # --- thumbnail from the finished video, as Cloud Run did ---
    thumbnail_started = time.perf_counter()
    temp_thumb = work_dir / "thumbnail.partial.jpg"
    final_thumb = work_dir / "thumbnail.jpg"
    thumb_result = _run(build_thumbnail_args(temp_output, temp_thumb), FFPROBE_TIMEOUT_SEC * 4)
    if thumb_result.returncode != 0:
        raise TimelapseError(
            f"thumbnail ffmpeg exited {thumb_result.returncode}: "
            f"{thumb_result.stderr.strip()[-500:]}"
        )
    validate_thumbnail(temp_thumb)
    thumbnail_ms = int((time.perf_counter() - thumbnail_started) * 1000)

    # Validated: promote both to their final names atomically.
    temp_output.replace(final_output)
    temp_thumb.replace(final_thumb)
    os.chmod(final_output, 0o600)
    os.chmod(final_thumb, 0o600)

    skipped = len(chunks) - len(usable)
    if skipped:
        log.warning("timelapse skipped %d unreadable chunk(s) of %d", skipped, len(chunks))

    return RenderResult(
        video_path=final_output,
        thumbnail_path=final_thumb,
        duration_sec=metrics["duration_sec"],
        size_bytes=metrics["size_bytes"],
        width=metrics["width"],
        height=metrics["height"],
        encoder=chosen,
        fallback_used=fallback_used,
        fallback_reason=fallback_reason,
        chunks_used=len(usable),
        chunks_skipped=skipped,
        encode_ms=encode_ms,
        thumbnail_ms=thumbnail_ms,
        probe_ms=probe_ms,
        warnings=warnings,
    )
