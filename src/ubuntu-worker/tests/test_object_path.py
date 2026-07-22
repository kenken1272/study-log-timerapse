"""Only real chunk objects may enter the pipeline."""

from __future__ import annotations

import pytest

from app.schemas import parse_chunk_object


def test_parses_a_valid_chunk_object():
    ref = parse_chunk_object(
        "users/abc123/sessions/sess-9/segments/0/chunks/42.webm", "1712345678901234"
    )
    assert ref is not None
    assert ref.uid == "abc123"
    assert ref.session_id == "sess-9"
    assert ref.segment_index == 0
    assert ref.chunk_index == 42
    assert ref.generation == "1712345678901234"


def test_generation_is_part_of_the_idempotency_key():
    # Same slot re-uploaded is a different chunk and must analyse separately.
    first = parse_chunk_object("users/u/sessions/s/segments/0/chunks/0.webm", "1")
    second = parse_chunk_object("users/u/sessions/s/segments/0/chunks/0.webm", "2")
    assert first.idempotency_key != second.idempotency_key


@pytest.mark.parametrize(
    "object_name",
    [
        # Our own output must never be re-ingested as input.
        "users/u/sessions/s/analysis/status.json",
        "users/u/sessions/s/analysis/chunks/0/0.json",
        "users/u/sessions/s/analysis.json",
        # Unrelated session artefacts.
        "users/u/sessions/s/timelapse.mp4",
        "users/u/sessions/s/thumbnail.jpg",
        "users/u/sessions/s/metadata.json",
        "users/u/profile.json",
        # Structurally wrong.
        "users/u/sessions/s/segments/0/chunks/0.mp4",
        "users/u/sessions/s/segments/x/chunks/0.webm",
        "users/u/sessions/s/segments/0/chunks/abc.webm",
        "sessions/s/segments/0/chunks/0.webm",
        "users//sessions/s/segments/0/chunks/0.webm",
        "users/u/sessions/s/segments/0/chunks/0.webm/extra",
        "",
    ],
)
def test_rejects_non_chunk_objects(object_name):
    assert parse_chunk_object(object_name, "1") is None


def test_rejects_path_traversal():
    assert parse_chunk_object("users/../sessions/s/segments/0/chunks/0.webm", "1") is None


def test_uid_with_slash_cannot_smuggle_a_path():
    # The regex forbids slashes inside uid, so this cannot redirect writes.
    assert parse_chunk_object(
        "users/a/b/sessions/s/segments/0/chunks/0.webm", "1"
    ) is None
