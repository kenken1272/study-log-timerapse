"""Running one session's timelapse end to end.

Sits between the readiness gate (timelapse_trigger), the renderer (timelapse)
and the durable job row (queue_db). Kept apart from main.py so the sequence can
be tested without a GPU, a bucket, or a Cloud Run instance.
"""

from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

import google.auth
import google.auth.transport.requests

from app import auth as worker_auth
from app import result_store, timelapse
from app.queue_db import (
    TL_CALLBACK_PENDING,
    TL_COMPLETED,
    TL_ENCODING,
    TL_UPLOADING,
    TL_VALIDATING,
)
from app.timelapse import SourceChunk, TimelapseFatal

log = logging.getLogger(__name__)

VIDEO_CONTENT_TYPE = "video/mp4"
THUMBNAIL_CONTENT_TYPE = "image/jpeg"

# Refuse to start unless the download will comfortably fit, with room for the
# render output and the OS. A three-hour session is roughly 800MB of source.
DISK_HEADROOM_MULTIPLIER = 3.0
DISK_HEADROOM_MIN_BYTES = 2 * 1024**3

CALLBACK_TIMEOUT_SEC = 30.0


class TimelapseJobError(Exception):
    """Retryable failure somewhere in the pipeline."""


def fetch_id_token(audience: str) -> str:
    """Mint a Google-issued OIDC token identifying the worker service account.

    google.oauth2.id_token.fetch_id_token() cannot be used here: it needs a
    metadata server or a key file, and this host has neither by design — it
    runs on a human's ADC impersonating the worker service account. The
    impersonation API mints the ID token instead, and include_email is required
    because Cloud Run authorises on the email claim, not just the audience.
    """
    from google.auth import impersonated_credentials

    target = worker_auth.target_service_account()
    source, _project = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )

    if not target:
        # No impersonation configured: ADC may already be a service account
        # that can self-sign an ID token.
        import google.oauth2.id_token

        return google.oauth2.id_token.fetch_id_token(
            google.auth.transport.requests.Request(), audience
        )

    delegated = impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=target,
        target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
        lifetime=600,
    )
    id_credentials = impersonated_credentials.IDTokenCredentials(
        delegated,
        target_audience=audience,
        include_email=True,
    )
    id_credentials.refresh(google.auth.transport.requests.Request())
    return id_credentials.token


def build_source_chunks(objects: list[dict]) -> list[SourceChunk]:
    """Turn a GCS listing into chunk records, dropping anything unparseable."""
    from app.schemas import parse_chunk_object

    chunks: list[SourceChunk] = []
    for entry in objects:
        ref = parse_chunk_object(entry["object_name"], entry["generation"])
        if ref is None:
            continue
        chunks.append(
            SourceChunk(
                object_name=ref.object_name,
                generation=ref.generation,
                segment_index=ref.segment_index,
                chunk_index=ref.chunk_index,
            )
        )
    return chunks


def estimate_required_bytes(objects: list[dict]) -> int:
    total = sum(int(entry.get("size_bytes") or 0) for entry in objects)
    return int(total * DISK_HEADROOM_MULTIPLIER) + DISK_HEADROOM_MIN_BYTES


class TimelapseRunner:
    """Renders one session, then tells Cloud Run about it."""

    def __init__(self, db, gcs, settings) -> None:
        self.db = db
        self.gcs = gcs
        self.settings = settings

    # ------------------------------------------------------------------

    def run(self, session_id: str, uid: str, speed: int) -> dict:
        """Render, upload and report. Raises on retryable failure."""
        work_dir = self.settings.spool_dir / f"timelapse-{session_id}"
        # A previous attempt may have left partial files; start from nothing so
        # a stale half-download cannot be concatenated into the output.
        shutil.rmtree(work_dir, ignore_errors=True)
        chunk_dir = work_dir / "chunks"
        chunk_dir.mkdir(parents=True, exist_ok=True)

        try:
            return self._run_inner(session_id, uid, speed, work_dir, chunk_dir)
        finally:
            # Never reach outside the directory this job created.
            if work_dir.exists() and work_dir.is_relative_to(self.settings.spool_dir):
                shutil.rmtree(work_dir, ignore_errors=True)

    def _run_inner(
        self, session_id: str, uid: str, speed: int, work_dir: Path, chunk_dir: Path
    ) -> dict:
        objects = self.gcs.list_chunk_objects(uid, session_id)
        if not objects:
            raise TimelapseFatal("no source chunks in GCS")

        required = estimate_required_bytes(objects)
        available = timelapse.free_disk_bytes(self.settings.spool_dir)
        if available < required:
            raise TimelapseJobError(
                f"insufficient disk: need ~{required // 1024**2}MB, "
                f"have {available // 1024**2}MB"
            )

        chunks = build_source_chunks(objects)
        ordered, warnings = timelapse.dedupe_and_sort(chunks)
        fingerprint = timelapse.source_fingerprint(ordered)

        # --- download, one at a time, straight to disk ---
        download_started = time.perf_counter()
        for index, chunk in enumerate(ordered):
            destination = chunk_dir / f"{index:05d}.webm"
            self.gcs.download_to(chunk.object_name, chunk.generation, destination)
            chunk.local_path = destination
        download_ms = int((time.perf_counter() - download_started) * 1000)

        # --- render ---
        self.db.set_timelapse_state(
            session_id, TL_ENCODING, source_fingerprint=fingerprint
        )
        result = timelapse.render(
            ordered,
            work_dir,
            speed=speed,
            encoder=self.settings.timelapse_encoder,
            gpu_index=self.settings.vlm_gpu,
            allow_fallback=True,
        )
        result.download_ms = download_ms
        result.warnings = warnings + result.warnings

        self.db.set_timelapse_state(session_id, TL_VALIDATING)
        # render() already validated; state recorded so an interrupted job is
        # attributable to the right phase.

        # --- upload ---
        self.db.set_timelapse_state(session_id, TL_UPLOADING)
        video_object = result_store.timelapse_path(uid, session_id)
        thumb_object = result_store.thumbnail_path(uid, session_id)

        upload_started = time.perf_counter()
        video_meta = self.gcs.upload_media(video_object, result.video_path, VIDEO_CONTENT_TYPE)
        thumb_meta = self.gcs.upload_media(
            thumb_object, result.thumbnail_path, THUMBNAIL_CONTENT_TYPE
        )
        upload_ms = int((time.perf_counter() - upload_started) * 1000)

        # --- tell Cloud Run ---
        self.db.set_timelapse_state(
            session_id,
            TL_CALLBACK_PENDING,
            output_object=video_object,
            thumbnail_object=thumb_object,
            encoder=result.encoder,
            fallback_used=1 if result.fallback_used else 0,
            duration_sec=result.duration_sec,
            size_bytes=result.size_bytes,
            chunks_used=result.chunks_used,
            chunks_skipped=result.chunks_skipped,
        )

        callback_started = time.perf_counter()
        self.notify_complete(
            session_id=session_id,
            uid=uid,
            fingerprint=fingerprint,
            video_object=video_object,
            thumb_object=thumb_object,
            video_meta=video_meta,
            thumb_meta=thumb_meta,
            result=result,
            speed=speed,
        )
        callback_ms = int((time.perf_counter() - callback_started) * 1000)

        self.db.set_timelapse_state(
            session_id, TL_COMPLETED, completed_at=time.time(),
            error_class=None, error_message=None,
        )

        metrics = {
            "session_id": session_id,
            "fingerprint": fingerprint,
            "encoder": result.encoder,
            "fallback_used": result.fallback_used,
            "chunks_used": result.chunks_used,
            "chunks_skipped": result.chunks_skipped,
            "duration_sec": round(result.duration_sec, 2),
            "size_bytes": result.size_bytes,
            "download_ms": download_ms,
            "probe_ms": result.probe_ms,
            "encode_ms": result.encode_ms,
            "thumbnail_ms": result.thumbnail_ms,
            "upload_ms": upload_ms,
            "callback_ms": callback_ms,
            "warnings": result.warnings,
        }
        log.info(
            "timelapse complete session=%s encoder=%s chunks=%d/%d "
            "encode=%dms upload=%dms total_size=%dB",
            session_id, result.encoder, result.chunks_used,
            result.chunks_used + result.chunks_skipped,
            result.encode_ms, upload_ms, result.size_bytes,
        )
        return metrics

    # ------------------------------------------------------------------

    def notify_complete(
        self, *, session_id, uid, fingerprint, video_object, thumb_object,
        video_meta, thumb_meta, result, speed,
    ) -> None:
        """Hand the result to Cloud Run, which owns Firestore."""
        import requests  # imported lazily; only this path needs it

        base = self.settings.cloud_run_url.rstrip("/")
        url = f"{base}/api/internal/sessions/{session_id}/timelapse-complete"
        token = fetch_id_token(base)

        payload = {
            "uid": uid,
            "sessionId": session_id,
            "sourceFingerprint": fingerprint,
            "timelapsePath": video_object,
            "thumbnailPath": thumb_object,
            "timelapseGeneration": video_meta["generation"],
            "thumbnailGeneration": thumb_meta["generation"],
            "sizeBytes": video_meta["size_bytes"],
            "durationSec": result.duration_sec,
            "speed": speed,
            "encoder": result.encoder,
            "fallbackUsed": result.fallback_used,
        }

        response = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
            timeout=CALLBACK_TIMEOUT_SEC,
        )
        if response.status_code >= 400:
            raise TimelapseJobError(
                f"completion callback returned {response.status_code}: "
                f"{response.text[:300]}"
            )
