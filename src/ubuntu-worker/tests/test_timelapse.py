"""Rendering: ordering, deduplication, validation, and the safety properties.

The ffmpeg tests skip themselves without ffmpeg so the suite still runs on a
bare checkout, but they are the ones that matter — they check the real encoder
against the real output contract the web UI depends on.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.timelapse import (
    OUTPUT_FPS,
    OUTPUT_WIDTH,
    THUMBNAIL_WIDTH,
    SourceChunk,
    TimelapseError,
    TimelapseFatal,
    auto_timelapse_speed,
    build_ffmpeg_args,
    build_thumbnail_args,
    dedupe_and_sort,
    encoder_args,
    render,
    source_fingerprint,
    validate_output,
    write_concat_file,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def chunk(segment=0, index=0, generation="1", path=None):
    return SourceChunk(
        object_name=f"users/u/sessions/s/segments/{segment}/chunks/{index}.webm",
        generation=generation,
        segment_index=segment,
        chunk_index=index,
        local_path=path,
    )


# --- speed: must match the TypeScript exactly ---

@pytest.mark.parametrize(
    "seconds,expected",
    [
        (0, 30),
        (44 * 60, 30),
        (45 * 60 - 1, 30),
        (45 * 60, 60),          # boundary: < 45min is 30, otherwise 60
        (119 * 60, 60),
        (120 * 60 - 1, 60),
        (120 * 60, 120),        # boundary: < 120min is 60, otherwise 120
        (300 * 60, 120),
    ],
)
def test_speed_matches_the_cloud_run_implementation(seconds, expected):
    """A different speed here would render the same session differently."""
    assert auto_timelapse_speed(seconds) == expected


# --- ordering and deduplication ---

def test_orders_by_segment_then_chunk():
    ordered, _ = dedupe_and_sort([
        chunk(1, 0), chunk(0, 1), chunk(1, 1), chunk(0, 0),
    ])
    assert [(c.segment_index, c.chunk_index) for c in ordered] == [
        (0, 0), (0, 1), (1, 0), (1, 1)
    ]


def test_reversed_arrival_is_sorted_back_into_timeline_order():
    ordered, _ = dedupe_and_sort([chunk(0, i) for i in (4, 0, 3, 1, 2)])
    assert [c.chunk_index for c in ordered] == [0, 1, 2, 3, 4]


def test_a_reuploaded_slot_contributes_once():
    """25 slots in the live database have two or three generations.

    Concatenating every row would repeat that moment in the finished video.
    """
    ordered, warnings = dedupe_and_sort([
        chunk(0, 0, "100"), chunk(0, 0, "200"), chunk(0, 1, "150"),
    ])
    assert len(ordered) == 2
    assert any("multiple uploads" in w for w in warnings)


def test_the_newest_generation_wins():
    ordered, _ = dedupe_and_sort([
        chunk(0, 0, "100"), chunk(0, 0, "300"), chunk(0, 0, "200"),
    ])
    assert ordered[0].generation == "300"


def test_generations_compare_numerically_not_lexically():
    # "9" > "10" as strings; the later upload must still win.
    ordered, _ = dedupe_and_sort([chunk(0, 0, "9"), chunk(0, 0, "10")])
    assert ordered[0].generation == "10"


def test_a_gap_is_reported():
    ordered, warnings = dedupe_and_sort([chunk(0, 0), chunk(0, 1), chunk(0, 5)])
    assert len(ordered) == 3
    assert any("missing chunk indices" in w for w in warnings)


def test_no_gap_warning_for_a_contiguous_run():
    _, warnings = dedupe_and_sort([chunk(0, i) for i in range(5)])
    assert not any("missing" in w for w in warnings)


def test_segments_are_evaluated_for_gaps_independently():
    # Each segment restarts at 0; that is not a gap.
    _, warnings = dedupe_and_sort([chunk(0, 0), chunk(0, 1), chunk(1, 0), chunk(1, 1)])
    assert not any("missing" in w for w in warnings)


# --- fingerprint ---

def test_fingerprint_is_stable_regardless_of_input_order():
    a = source_fingerprint([chunk(0, 0, "1"), chunk(0, 1, "2")])
    b = source_fingerprint([chunk(0, 1, "2"), chunk(0, 0, "1")])
    assert a == b


def test_fingerprint_changes_when_a_chunk_is_reuploaded():
    """This is how a completed render learns it is out of date."""
    before = source_fingerprint([chunk(0, 0, "1")])
    after = source_fingerprint([chunk(0, 0, "2")])
    assert before != after


def test_fingerprint_changes_when_a_late_chunk_arrives():
    before = source_fingerprint([chunk(0, 0, "1")])
    after = source_fingerprint([chunk(0, 0, "1"), chunk(0, 1, "2")])
    assert before != after


# --- command construction ---

def test_ffmpeg_arguments_match_the_output_contract():
    args = build_ffmpeg_args(Path("/tmp/f.txt"), Path("/tmp/o.mp4"), 60, "libx264", None)
    joined = " ".join(args)
    assert f"setpts=PTS/60,fps={OUTPUT_FPS},scale={OUTPUT_WIDTH}:-2" in joined
    assert "-an" in args                      # no audio
    assert "yuv420p" in args                  # web-compatible
    assert "+faststart" in args               # streams before fully downloaded
    assert "-crf" in args and "28" in args    # quality matched to Cloud Run


def test_nvenc_arguments_pin_the_gpu():
    args = build_ffmpeg_args(Path("/f"), Path("/o"), 30, "h264_nvenc", 0)
    assert "h264_nvenc" in args
    assert args[args.index("-gpu") + 1] == "0"


def test_libx264_never_receives_a_gpu_flag():
    args = build_ffmpeg_args(Path("/f"), Path("/o"), 30, "libx264", 0)
    assert "-gpu" not in args


def test_encoder_arguments_are_quality_matched():
    assert encoder_args("libx264") == [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    ]
    assert "-cq" in encoder_args("h264_nvenc")


def test_thumbnail_arguments_match_the_cloud_run_output():
    args = build_thumbnail_args(Path("/v.mp4"), Path("/t.jpg"))
    assert f"scale={THUMBNAIL_WIDTH}:-2" in " ".join(args)
    assert args[args.index("-q:v") + 1] == "3"
    assert args[args.index("-frames:v") + 1] == "1"


def test_ffmpeg_is_never_invoked_through_a_shell():
    """Object names reach these arguments; a shell would make them injectable."""
    args = build_ffmpeg_args(Path("/tmp/a b.txt"), Path("/tmp/o.mp4"), 30, "libx264", None)
    assert isinstance(args, list)
    assert all(isinstance(a, str) for a in args)
    # The path stays one argument rather than being split on the space.
    assert "/tmp/a b.txt" in args


def test_concat_file_escapes_quotes(tmp_path):
    target = tmp_path / "f.txt"
    c = chunk(path=Path("/spool/it's here/chunk.webm"))
    write_concat_file([c], target)
    content = target.read_text()
    # ffmpeg's concat demuxer expects '\'' for an embedded single quote.
    assert "'\\''" in content
    assert content.startswith("file '")


# --- validation ---

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_validation_rejects_an_empty_file(tmp_path):
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    with pytest.raises(TimelapseError, match="missing or empty"):
        validate_output(empty, 0, 0)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_validation_rejects_a_missing_file(tmp_path):
    with pytest.raises(TimelapseError):
        validate_output(tmp_path / "nope.mp4", 0, 0)


# --- real ffmpeg, real contract ---

@pytest.fixture(scope="module")
def webm_chunks(tmp_path_factory):
    """Three 3-second VP8 chunks, the codec browsers actually produce."""
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not installed")
    directory = tmp_path_factory.mktemp("chunks")
    paths = []
    for index in range(3):
        path = directory / f"{index}.webm"
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=30:duration=3",
             "-c:v", "libvpx", "-b:v", "300k", "-cpu-used", "8", str(path)],
            check=True,
        )
        paths.append(path)
    return paths


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_render_produces_a_web_compatible_video(tmp_path, webm_chunks):
    chunks = [chunk(0, i, str(i + 1), p) for i, p in enumerate(webm_chunks)]
    result = render(chunks, tmp_path / "work", speed=3, encoder="libx264")

    assert result.video_path.exists()
    assert result.thumbnail_path.exists()
    assert result.width == OUTPUT_WIDTH
    assert result.height % 2 == 0
    assert result.chunks_used == 3
    assert result.chunks_skipped == 0
    assert result.encoder == "libx264"
    assert result.fallback_used is False
    assert result.size_bytes > 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_render_skips_a_truncated_chunk_rather_than_failing(tmp_path, webm_chunks):
    """20 chunks in the live database fail ffprobe this exact way.

    Production's message is "0x00 at pos 36 (0x24) invalid as first byte of an
    EBML number ... End of file": a valid header followed by zeros, which is
    what an aborted upload leaves behind. Reproduced byte-for-byte here.

    Note this is stricter than plain truncation — a merely short file still
    probes cleanly and ffmpeg decodes what is there, so those are kept rather
    than discarded.
    """
    corrupt = tmp_path / "corrupt.webm"
    corrupt.write_bytes(webm_chunks[0].read_bytes()[:36] + b"\x00" * 4000)

    chunks = [
        chunk(0, 0, "1", webm_chunks[0]),
        chunk(0, 1, "2", corrupt),
        chunk(0, 2, "3", webm_chunks[1]),
    ]
    result = render(chunks, tmp_path / "work", speed=3, encoder="libx264")

    assert result.chunks_used == 2
    assert result.chunks_skipped == 1
    assert any("unreadable" in w for w in result.warnings)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_render_refuses_when_every_chunk_is_unreadable(tmp_path, webm_chunks):
    corrupt = tmp_path / "bad.webm"
    corrupt.write_bytes(b"not a video at all")  # fails EBML header parsing
    with pytest.raises(TimelapseFatal, match="no readable chunks"):
        render([chunk(0, 0, "1", corrupt)], tmp_path / "work", speed=3)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_render_refuses_when_nothing_was_downloaded(tmp_path):
    with pytest.raises(TimelapseFatal):
        render([chunk(0, 0, "1", tmp_path / "absent.webm")], tmp_path / "work", speed=3)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_output_has_no_audio_stream(tmp_path, webm_chunks):
    chunks = [chunk(0, i, str(i), p) for i, p in enumerate(webm_chunks)]
    result = render(chunks, tmp_path / "work", speed=3, encoder="libx264")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", str(result.video_path)],
        capture_output=True, text=True,
    )
    assert probe.stdout.strip() == ""


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_no_partial_output_survives_a_failed_render(tmp_path, webm_chunks):
    """Output is promoted only after validation, so a crash publishes nothing."""
    work = tmp_path / "work"
    corrupt = tmp_path / "bad.webm"
    corrupt.write_bytes(b"junk")  # unreadable, so the render cannot proceed
    with pytest.raises(TimelapseFatal):
        render([chunk(0, 0, "1", corrupt)], work, speed=3)
    assert not (work / "timelapse.mp4").exists()


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_duration_reflects_the_requested_speed(tmp_path, webm_chunks):
    # 3 chunks x 3s = 9s of source; at speed 3 that is ~3s of output.
    chunks = [chunk(0, i, str(i), p) for i, p in enumerate(webm_chunks)]
    result = render(chunks, tmp_path / "work", speed=3, encoder="libx264")
    assert 2.0 < result.duration_sec < 4.5


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
def test_a_merely_short_chunk_is_kept_not_discarded(tmp_path, webm_chunks):
    """Salvage what decodes.

    A chunk cut short mid-stream still probes cleanly and still contains real
    footage. Dropping it would lose seconds of the recording for no reason;
    only chunks ffprobe rejects outright are skipped.
    """
    short = tmp_path / "short.webm"
    short.write_bytes(webm_chunks[0].read_bytes()[:2000])

    result = render(
        [chunk(0, 0, "1", short), chunk(0, 1, "2", webm_chunks[1])],
        tmp_path / "work", speed=3, encoder="libx264",
    )
    assert result.chunks_used == 2
    assert result.chunks_skipped == 0
