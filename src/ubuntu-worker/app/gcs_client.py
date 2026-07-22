"""Thin GCS wrapper.

Scope is deliberately narrow: read chunks, write analysis JSON. There is no
delete path anywhere in this module, and tests/test_no_delete_capability.py
enforces that.

That test matters more than it looks: the worker authenticates with ADC
belonging to a human account, which can almost certainly delete bucket objects.
The IAM layer therefore does not stop us from destroying a user's footage — only
the absence of a delete call does.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from google.api_core import exceptions as gcp_exceptions
from google.cloud import storage

from app import auth

log = logging.getLogger(__name__)

# Errors worth retrying rather than dead-lettering.
TRANSIENT_ERRORS = (
    gcp_exceptions.ServiceUnavailable,
    gcp_exceptions.TooManyRequests,
    gcp_exceptions.InternalServerError,
    gcp_exceptions.GatewayTimeout,
    gcp_exceptions.DeadlineExceeded,
    ConnectionError,
    TimeoutError,
)


class ChunkGone(Exception):
    """The source chunk no longer exists — usually cleanup won the race."""


class GcsClient:
    def __init__(self, project_id: str, bucket_name: str) -> None:
        self._client = storage.Client(
            project=project_id, credentials=auth.build_credentials()
        )
        self._bucket = self._client.bucket(bucket_name)
        self.bucket_name = bucket_name

    def download_chunk(
        self, object_name: str, generation: str | None, destination: Path
    ) -> int:
        """Download a specific generation. Returns bytes written."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Spool files can contain a person's study footage: keep them private.
        os.umask(0o077)
        blob = self._bucket.blob(
            object_name, generation=int(generation) if generation else None
        )
        try:
            blob.download_to_filename(str(destination))
        except gcp_exceptions.NotFound as error:
            raise ChunkGone(f"{object_name} (generation {generation})") from error
        return destination.stat().st_size

    def upload_json(self, object_name: str, payload: Any) -> None:
        blob = self._bucket.blob(object_name)
        blob.cache_control = "no-store"
        blob.upload_from_string(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            content_type="application/json",
        )

    def read_json(self, object_name: str) -> Any | None:
        blob = self._bucket.blob(object_name)
        try:
            return json.loads(blob.download_as_bytes())
        except gcp_exceptions.NotFound:
            return None

    def upload_media(
        self, object_name: str, source: Path, content_type: str
    ) -> dict:
        """Upload a rendered artefact and read back what GCS actually stored.

        Only ever called for timelapse.mp4 and thumbnail.jpg. Deliberately not
        generic: this class has no delete surface and no way to write an
        arbitrary path, which is what keeps a bug here from touching a user's
        source recordings.
        """
        blob = self._bucket.blob(object_name)
        # Long-lived and immutable per generation; the UI fetches via signed
        # URLs that already carry their own expiry.
        blob.cache_control = "private, max-age=3600"
        blob.upload_from_filename(str(source), content_type=content_type)

        # Trust the server's view, not ours: a truncated upload would otherwise
        # be reported as a success.
        blob.reload()
        stored = int(blob.size or 0)
        local = source.stat().st_size
        if stored != local:
            raise ValueError(
                f"upload size mismatch for {object_name}: "
                f"local {local} bytes, GCS {stored} bytes"
            )
        if blob.content_type != content_type:
            raise ValueError(
                f"content-type mismatch for {object_name}: "
                f"expected {content_type}, GCS reports {blob.content_type}"
            )
        return {
            "generation": str(blob.generation),
            "size_bytes": stored,
            "content_type": blob.content_type,
        }

    def stat(self, object_name: str) -> dict | None:
        """Size, generation and content type, or None when absent."""
        blob = self._bucket.blob(object_name)
        try:
            blob.reload()
        except gcp_exceptions.NotFound:
            return None
        return {
            "generation": str(blob.generation),
            "size_bytes": int(blob.size or 0),
            "content_type": blob.content_type,
        }

    def download_to(self, object_name: str, generation: str | None, destination: Path) -> int:
        """Stream one object to disk. Alias of download_chunk for readability."""
        return self.download_chunk(object_name, generation, destination)

    def list_chunk_objects(self, uid: str, session_id: str) -> list[dict]:
        """List a session's source chunks with their generations."""
        prefix = f"users/{uid}/sessions/{session_id}/segments/"
        found = []
        for blob in self._client.list_blobs(self._bucket, prefix=prefix):
            if not blob.name.endswith(".webm"):
                continue
            found.append({
                "object_name": blob.name,
                "generation": str(blob.generation),
                "size_bytes": int(blob.size or 0),
                "time_created": blob.time_created.isoformat() if blob.time_created else None,
            })
        return found

    def list_names(self, prefix: str) -> list[str]:
        return [blob.name for blob in self._client.list_blobs(self._bucket, prefix=prefix)]

    def exists(self, object_name: str) -> bool:
        return self._bucket.blob(object_name).exists()


def is_transient(error: BaseException) -> bool:
    return isinstance(error, TRANSIENT_ERRORS)
