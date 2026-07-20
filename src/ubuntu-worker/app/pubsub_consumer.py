"""Pub/Sub pull subscriber for GCS OBJECT_FINALIZE notifications.

Pull rather than push: the Ubuntu host sits behind Tailscale with no public
HTTPS endpoint, and Pub/Sub retains events while the box is down.

The callback never runs inference. It validates, commits to SQLite, then acks —
so a crash mid-inference costs a redelivery, not a lost chunk.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Callable

from app.queue_db import QueueDB
from app.schemas import ChunkRef, parse_chunk_object

log = logging.getLogger(__name__)

EVENT_FINALIZE = "OBJECT_FINALIZE"


def parse_notification(message) -> tuple[ChunkRef | None, str | None, str | None]:
    """Extract (ChunkRef, bucket, timeCreated) from a GCS notification.

    Returns (None, ...) for anything that is not an analysable chunk finalize —
    deletes, metadata updates, and our own writes under analysis/.
    """
    attributes = dict(message.attributes or {})
    if attributes.get("eventType") != EVENT_FINALIZE:
        return None, None, None

    object_name = attributes.get("objectId")
    bucket = attributes.get("bucketId")
    generation = attributes.get("objectGeneration")
    if not object_name or not bucket or not generation:
        return None, None, None

    ref = parse_chunk_object(object_name, generation)
    if ref is None:
        return None, None, None

    time_created = None
    if message.data:
        try:
            time_created = json.loads(message.data).get("timeCreated")
        except (json.JSONDecodeError, UnicodeDecodeError):
            # The attributes carry everything essential; payload is a bonus.
            log.debug("notification payload was not JSON for %s", object_name)

    return ref, bucket, time_created


class PubSubConsumer:
    def __init__(
        self,
        project_id: str,
        subscription_id: str,
        db: QueueDB,
        on_enqueue: Callable[[ChunkRef], None] | None = None,
    ) -> None:
        # Imported here so parse_notification stays testable without the SDK.
        from google.cloud import pubsub_v1

        self._pubsub = pubsub_v1
        self._client = pubsub_v1.SubscriberClient()
        self._path = self._client.subscription_path(project_id, subscription_id)
        self._db = db
        self._on_enqueue = on_enqueue
        self._future = None
        self._lock = threading.Lock()

    def _callback(self, message) -> None:
        try:
            ref, bucket, time_created = parse_notification(message)
            if ref is None:
                # Not ours. Ack so it stops being redelivered forever.
                message.ack()
                return

            # SQLite is single-writer; serialise the callback threads.
            with self._lock:
                inserted = self._db.enqueue(ref, bucket, time_created)

            if inserted:
                log.info(
                    "queued chunk session=%s segment=%d chunk=%d gen=%s",
                    ref.session_id, ref.segment_index, ref.chunk_index, ref.generation,
                )
                if self._on_enqueue:
                    self._on_enqueue(ref)
            else:
                log.debug("duplicate delivery ignored: %s", ref.idempotency_key)

            # Ack only after the commit above succeeded.
            message.ack()
        except Exception:
            log.exception("failed to handle notification; nacking for redelivery")
            message.nack()

    def start(self) -> None:
        flow_control = self._pubsub.types.FlowControl(max_messages=100)
        self._future = self._client.subscribe(
            self._path, callback=self._callback, flow_control=flow_control
        )
        log.info("subscribed to %s", self._path)

    def stop(self, timeout: float = 15.0) -> None:
        if self._future is not None:
            self._future.cancel()
            try:
                self._future.result(timeout=timeout)
            except Exception:
                log.debug("subscriber shutdown completed with an exception", exc_info=True)
        self._client.close()
