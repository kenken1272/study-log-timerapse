"""Worker entrypoint.

Two cooperating loops on one process:
  * chunk loop  — drains the SQLite queue, one 30s chunk at a time, VLM resident
  * window loop — closes 30-minute windows and finalises ended sessions via LLM

The Pub/Sub subscriber runs on its own threads and only ever writes to SQLite.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import aggregator, gpu_manager, result_store, video_frames
from app.gcs_client import ChunkGone, GcsClient, is_transient
from app.health import HealthServer
from app.llm_runtime import (
    LlmConfig,
    MockLlmRuntime,
    TransformersLlmRuntime,
    build_fallback_ladder,
)
from app.logging_config import configure as configure_logging
from app.pubsub_consumer import PubSubConsumer
from app.queue_db import (
    STATE_COMPLETED,
    STATE_EXTRACTING,
    STATE_UPLOADING,
    STATE_VLM_DONE,
    STATE_VLM_RUNNING,
    QueueDB,
)
from app.schemas import (
    AnalysisStatus,
    ChunkAnalysis,
    ChunkRuntime,
    SampledFrame,
    utc_now_iso,
)
from app.settings import PROFILE_ORDER, Settings, load_settings
from app.vlm_runtime import SchemaViolation, build_runtime

log = logging.getLogger(__name__)

# Two consecutive SLO misses demote the profile. One slow chunk is noise —
# a GC pause or a large upload — and must not permanently degrade quality.
DEMOTION_STREAK = 2
IDLE_SLEEP_SEC = 2.0
WINDOW_CHECK_INTERVAL_SEC = 60.0


class Worker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.db = QueueDB(settings.db_path)
        self.gcs = GcsClient(settings.project_id, settings.bucket_name)
        self.vlm = build_runtime(settings)
        self.llm = MockLlmRuntime() if settings.dry_run else TransformersLlmRuntime(
            gpu_index=settings.llm_gpu,
            revision=settings.llm_revision,
            compute_dtype=settings.llm_compute_dtype,
        )
        self.gpu_lock = gpu_manager.GpuLock(settings.root / "state")
        self.profile = settings.vlm_profile
        self.demoted = False
        self._slo_miss_streak = 0
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._consumer: PubSubConsumer | None = None
        self._health: HealthServer | None = None
        self._last_chunk_ms = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        recovered = self.db.recover_in_flight()
        if recovered:
            log.info("recovered %d chunks abandoned by a previous run", recovered)

        stored_profile = self.db.get_meta("vlm_profile")
        if stored_profile in PROFILE_ORDER:
            self.profile = stored_profile
            self.demoted = self.db.get_meta("vlm_demoted") == "1"
            log.info("resuming with profile %s (demoted=%s)", self.profile, self.demoted)

        self._check_gpu_topology()

        log.info("loading VLM…")
        self.vlm.warmup()

        self._health = HealthServer(self.settings.health_port, self.health_snapshot)
        self._health.start()

        self._consumer = PubSubConsumer(
            self.settings.project_id,
            self.settings.subscription_id,
            self.db,
            on_enqueue=lambda _ref: self._wake.set(),
        )
        self._consumer.start()

        threading.Thread(target=self._window_loop, name="windows", daemon=True).start()
        self._chunk_loop()

    def shutdown(self, *_args) -> None:
        log.info("shutdown requested")
        self._stop.set()
        self._wake.set()

    def cleanup(self) -> None:
        if self._consumer:
            self._consumer.stop()
        if self._health:
            self._health.stop()
        try:
            self.vlm.unload()
        except Exception:
            log.debug("VLM unload during shutdown failed", exc_info=True)
        self.db.close()
        log.info("worker stopped cleanly")

    def _check_gpu_topology(self) -> None:
        """Detect the cards being renumbered across a reboot."""
        uuids = gpu_manager.gpu_uuids()
        if not uuids:
            log.warning("nvidia-smi unavailable; skipping GPU topology check")
            return
        current = f"{self.settings.vlm_gpu}={uuids.get(self.settings.vlm_gpu)}," \
                  f"{self.settings.llm_gpu}={uuids.get(self.settings.llm_gpu)}"
        previous = self.db.get_meta("gpu_topology")
        if previous and previous != current:
            log.warning(
                "GPU topology changed since last run (was %s, now %s) — "
                "verify VLM_GPU/LLM_GPU still point at the intended cards",
                previous, current,
            )
        self.db.set_meta("gpu_topology", current)

    # ------------------------------------------------------------------
    # Chunk loop
    # ------------------------------------------------------------------

    def _chunk_loop(self) -> None:
        while not self._stop.is_set():
            row = self.db.claim_next()
            if row is None:
                self._wake.wait(timeout=IDLE_SLEEP_SEC)
                self._wake.clear()
                continue
            try:
                self._process_chunk(row)
            except Exception:
                log.exception("unhandled error processing %s", row["idempotency_key"])
                self.db.fail(
                    row["idempotency_key"], "unhandled", "unhandled worker error",
                    self.settings.max_attempts,
                )

    def _process_chunk(self, row) -> None:
        key = row["idempotency_key"]
        started = time.perf_counter()
        work_dir = self.settings.spool_dir / key.replace("/", "_").replace("#", "@")
        local_video = work_dir / "chunk.webm"

        # --- download ---
        download_started = time.perf_counter()
        try:
            self.gcs.download_chunk(row["object_name"], row["generation"], local_video)
        except ChunkGone as error:
            # Cleanup deleted the chunk before we got to it. Retrying cannot
            # help, so this is terminal — but it is recorded, not silent.
            log.warning("source chunk gone, dead-lettering: %s", error)
            self.db.set_state(
                key, "DEAD_LETTER", error_class="chunk_gone", error_message=str(error)
            )
            self._publish_status(row["uid"], row["session_id"])
            return
        except Exception as error:
            self._retry(key, error, "download")
            return
        download_ms = int((time.perf_counter() - download_started) * 1000)

        # --- frames ---
        self.db.set_state(key, STATE_EXTRACTING, local_path=str(local_video))
        extract_started = time.perf_counter()
        try:
            frames = video_frames.extract_frames(local_video, self.profile, work_dir / "frames")
        except Exception as error:
            self._retry(key, error, "frame_extract")
            return
        frame_extract_ms = int((time.perf_counter() - extract_started) * 1000)

        # --- VLM ---
        self.db.set_state(key, STATE_VLM_RUNNING)
        try:
            result = self.vlm.analyze(frames)
        except SchemaViolation as error:
            log.warning("schema violation on %s: %s", key, error)
            self._retry(key, error, "vlm_schema")
            return
        except Exception as error:
            self._retry(key, error, "vlm")
            return
        self.db.set_state(key, STATE_VLM_DONE)

        # --- upload ---
        analysis = ChunkAnalysis(
            uid=row["uid"],
            session_id=row["session_id"],
            segment_index=row["segment_index"],
            chunk_index=row["chunk_index"],
            gcs_generation=row["generation"],
            source_object=row["object_name"],
            chunk_started_at=row["gcs_time_created"],
            chunk_ended_at=None,
            profile=self.profile,
            sampled_frames=[
                SampledFrame(offset_seconds=offset, width=frames.width, height=frames.height)
                for offset in frames.offsets_seconds
            ],
            metrics=result.metrics,
            runtime=ChunkRuntime(
                model=self.vlm.model_id,
                quantization=self.vlm.quantization,
                compute_dtype=getattr(self.vlm, "compute_dtype", "unknown"),
                dry_run=self.settings.dry_run,
                download_ms=download_ms,
                frame_extract_ms=frame_extract_ms,
                vlm_preprocess_ms=result.preprocess_ms,
                vlm_generate_ms=result.generate_ms,
                json_validate_ms=result.validate_ms,
                peak_vram_mib=result.peak_vram_mib,
            ),
            created_at=utc_now_iso(),
        )

        self.db.set_state(key, STATE_UPLOADING)
        upload_started = time.perf_counter()
        object_path = result_store.chunk_analysis_path(
            row["uid"], row["session_id"], row["segment_index"], row["chunk_index"]
        )
        try:
            analysis.runtime.upload_ms = 0
            analysis.runtime.total_ms = int((time.perf_counter() - started) * 1000)
            self.gcs.upload_json(object_path, analysis.model_dump())
        except Exception as error:
            self._retry(key, error, "upload")
            return
        upload_ms = int((time.perf_counter() - upload_started) * 1000)

        total_ms = int((time.perf_counter() - started) * 1000)
        self._last_chunk_ms = total_ms
        self.db.set_state(key, STATE_COMPLETED, result_object=object_path)

        # Footage is deleted only once its analysis is safely in GCS.
        self._cleanup_spool(work_dir)
        self._check_slo(total_ms)
        self._publish_status(row["uid"], row["session_id"])

        log.info(
            "chunk done session=%s seg=%d idx=%d total=%dms (dl=%d fx=%d vlm=%d up=%d) profile=%s",
            row["session_id"], row["segment_index"], row["chunk_index"],
            total_ms, download_ms, frame_extract_ms, result.generate_ms, upload_ms,
            self.profile,
        )

    def _retry(self, key: str, error: Exception, stage: str) -> None:
        classification = "transient" if is_transient(error) else stage
        state = self.db.fail(
            key, classification, f"{stage}: {error}", self.settings.max_attempts
        )
        log.warning("chunk %s -> %s at stage %s: %s", key, state, stage, error)

    def _cleanup_spool(self, work_dir: Path) -> None:
        import shutil

        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            log.debug("spool cleanup failed for %s", work_dir, exc_info=True)

    def _check_slo(self, total_ms: int) -> None:
        if total_ms <= self.settings.vlm_slo_ms:
            self._slo_miss_streak = 0
            return

        self._slo_miss_streak += 1
        log.warning(
            "chunk exceeded SLO: %dms > %dms (streak %d/%d)",
            total_ms, self.settings.vlm_slo_ms, self._slo_miss_streak, DEMOTION_STREAK,
        )
        if self._slo_miss_streak < DEMOTION_STREAK:
            return

        order = list(PROFILE_ORDER)
        current = order.index(self.profile) if self.profile in order else 0
        if current + 1 >= len(order):
            log.error("already on the lightest profile (%s); cannot demote further", self.profile)
            self._slo_miss_streak = 0
            return

        self.profile = order[current + 1]
        self.demoted = True
        self._slo_miss_streak = 0
        self.db.set_meta("vlm_profile", self.profile)
        self.db.set_meta("vlm_demoted", "1")
        # Promotion is never automatic: it requires an explicit re-benchmark.
        log.warning("demoted to profile %s; re-run the benchmark to restore quality", self.profile)

    # ------------------------------------------------------------------
    # Window / final loop
    # ------------------------------------------------------------------

    def _window_loop(self) -> None:
        while not self._stop.wait(WINDOW_CHECK_INTERVAL_SEC):
            try:
                self._tick_windows()
            except Exception:
                log.exception("window loop iteration failed")

    def _tick_windows(self) -> None:
        for session in self.db.active_sessions():
            session_id = session["session_id"]
            uid = session["uid"]

            for plan in aggregator.plan_windows(
                self.db, session_id, uid, self.settings.window_minutes
            ):
                self._run_aggregation(plan)

            if self._session_has_ended(uid, session_id):
                self._finalize_session(uid, session_id)

    def _session_has_ended(self, uid: str, session_id: str) -> bool:
        """Trust the app's own end signal rather than inventing a new one."""
        metadata = self.gcs.read_json(
            f"{result_store.session_prefix(uid, session_id)}metadata.json"
        )
        if not metadata:
            return False
        session = metadata.get("session") or {}
        if session.get("endedAt"):
            return True
        return session.get("status") in ("ready", "failed")

    def _finalize_session(self, uid: str, session_id: str) -> None:
        pending = self.db.pending_count_for_session(session_id)
        if pending:
            row = self.db._conn.execute(  # noqa: SLF001 - internal read is intentional
                "SELECT ended_at FROM sessions WHERE session_id=?", (session_id,)
            ).fetchone()
            first_seen = row["ended_at"] if row and row["ended_at"] else None
            if first_seen is None:
                self.db.mark_session_ended(session_id, time.time())
                log.info(
                    "session %s ended with %d chunks in flight; waiting up to %ds",
                    session_id, pending, self.settings.session_end_grace_sec,
                )
                return
            if time.time() - first_seen < self.settings.session_end_grace_sec:
                return
            log.warning(
                "grace period elapsed for %s with %d chunks unfinished; "
                "finalising with recorded gaps", session_id, pending,
            )

        plan = aggregator.plan_final(self.db, session_id, uid)
        if plan is None:
            log.warning("session %s ended with no analysable chunks", session_id)
            self.db.mark_session_finalized(session_id)
            self._publish_status(uid, session_id, state="failed",
                                 message="分析できたチャンクがありませんでした。")
            return

        if self._run_aggregation(plan):
            self.db.mark_session_finalized(session_id)
            self._publish_status(uid, session_id, state="ready")

    def _run_aggregation(self, plan: aggregator.WindowPlan) -> bool:
        if not self.db.claim_aggregation(
            plan.aggregation_key, plan.session_id, plan.uid, plan.analysis_type,
            plan.start.isoformat(), plan.end.isoformat(),
        ):
            log.debug("aggregation %s already done", plan.aggregation_key)
            return False

        log.info(
            "running %s aggregation for %s (%d chunks)",
            plan.analysis_type, plan.session_id, len(plan.rows),
        )
        self._publish_status(plan.uid, plan.session_id, state="processing")

        try:
            payloads = self._load_chunk_payloads(plan)
            ladder = self._build_ladder()
            with self.gpu_lock.acquire(timeout=1800):
                analysis = aggregator.build_analysis(plan, payloads, self.llm, ladder)
            self.gcs.upload_json(aggregator.analysis_object_path(plan), analysis.model_dump())
            self.db.finish_aggregation(plan.aggregation_key, "DONE")
            log.info(
                "%s analysis stored (model=%s fallback=%s)",
                plan.analysis_type, analysis.runtime.used_model, analysis.runtime.fallback_used,
            )
            return True
        except Exception as error:
            log.exception("aggregation %s failed", plan.aggregation_key)
            self.db.finish_aggregation(plan.aggregation_key, "FAILED", str(error))
            self._publish_status(plan.uid, plan.session_id, state="partial",
                                 message="統合分析に失敗しました。再試行されます。")
            return False

    def _load_chunk_payloads(self, plan: aggregator.WindowPlan) -> list[dict]:
        payloads = []
        for row in plan.rows:
            path = row["result_object"] or result_store.chunk_analysis_path(
                plan.uid, plan.session_id, row["segment_index"], row["chunk_index"]
            )
            payload = self.gcs.read_json(path)
            if payload:
                payloads.append(payload)
        return payloads

    def _build_ladder(self) -> list[LlmConfig]:
        """Primary 27B, its degradations, then the smaller 12B as a last resort."""
        primary = LlmConfig(
            model_id=self.settings.llm_model_id,
            display_name=self.settings.llm_model_id,
            context_size=self.settings.llm_context_size,
            max_output_tokens=self.settings.llm_max_output_tokens,
        )
        alternates = []
        fallback = self.settings.llm_fallback_model_id
        if fallback and fallback != self.settings.llm_model_id:
            alternates.append(
                LlmConfig(
                    model_id=fallback,
                    display_name=fallback,
                    context_size=min(self.settings.llm_context_size, 8192),
                    max_output_tokens=self.settings.llm_max_output_tokens,
                )
            )
        return build_fallback_ladder(primary, alternates)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def _publish_status(
        self, uid: str, session_id: str, state: str | None = None, message: str | None = None
    ) -> None:
        counts = self.db.session_counts(session_id)
        completed = counts.get(STATE_COMPLETED, 0)
        failed = counts.get("DEAD_LETTER", 0)
        total = counts.get("TOTAL", 0)

        if state is None:
            if failed and completed == 0:
                state = "failed"
            elif completed < total:
                state = "processing"
            else:
                state = "partial"

        status = AnalysisStatus(
            session_id=session_id,
            state=state,
            chunks_total=total,
            chunks_completed=completed,
            chunks_failed=failed,
            windows_completed=len(self.db.completed_aggregations(session_id)),
            current_profile=self.profile,
            demoted=self.demoted,
            message=message,
            updated_at=utc_now_iso(),
        )
        try:
            self.gcs.upload_json(result_store.status_path(uid, session_id), status.model_dump())
        except Exception:
            # Advisory, so it must never fail a chunk — but it drives the UI's
            # progress display, so a persistent failure has to be visible.
            # Logging this at debug once hid a 403 that silently froze the
            # status at "1 of 4" for an entire session.
            log.warning(
                "status publish failed for %s (UI progress will be stale)",
                session_id, exc_info=True,
            )

    def health_snapshot(self) -> dict:
        usage = gpu_manager.memory_used_mib()
        return {
            "ok": not self._stop.is_set(),
            "profile": self.profile,
            "demoted": self.demoted,
            "last_chunk_ms": self._last_chunk_ms,
            "slo_ms": self.settings.vlm_slo_ms,
            "slo_miss_streak": self._slo_miss_streak,
            "gpu_memory_used_mib": usage,
            "vlm_gpu": self.settings.vlm_gpu,
            "llm_gpu": self.settings.llm_gpu,
            "model": self.vlm.model_id,
        }


def purge_stale_spool(settings: Settings) -> int:
    """Delete spooled footage left behind by dead-lettered chunks."""
    import shutil

    if not settings.spool_dir.exists():
        return 0
    cutoff = time.time() - settings.spool_retention_sec
    removed = 0
    for entry in settings.spool_dir.iterdir():
        try:
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


def main() -> int:
    settings = load_settings()
    configure_logging(settings.log_dir)
    log.info("study-timelapse-worker starting (dry_run=%s)", settings.dry_run)

    purged = purge_stale_spool(settings)
    if purged:
        log.info("purged %d stale spool directories", purged)

    worker = Worker(settings)
    signal.signal(signal.SIGTERM, worker.shutdown)
    signal.signal(signal.SIGINT, worker.shutdown)

    try:
        worker.start()
    finally:
        worker.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
