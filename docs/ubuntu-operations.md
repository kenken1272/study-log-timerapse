# Ubuntu worker — operations

Host: `suzukilab@100.74.222.81` (slabPCX, Ubuntu 24.04, 2× TITAN RTX 24GB)
Root: `/home/suzukilab/study-timelapse-worker`

## Layout

```
current/            deployed source (rsync target — never edit here)
venv/               virtualenv
models/             local model artefacts (never in git)
                    HF weights live in ~/.cache/huggingface/hub, shared with
                    the lab's other work — do not duplicate them here
state/pipeline.db   SQLite queue
state/*.lock        GPU exclusion locks
state/gpu-restore-* restart info for services stopped for this pipeline
spool/              transient video, umask 077, deleted after upload
logs/worker.log     rotating, 20MB × 5
config/worker.env   credentials, chmod 600, never committed
```

## Everyday commands

```bash
# status
systemctl --user status study-timelapse-worker

# logs
journalctl --user -u study-timelapse-worker -f
tail -f ~/study-timelapse-worker/logs/worker.log

# health (loopback only)
curl -s http://127.0.0.1:8799/health | python3 -m json.tool

# start / stop / restart
systemctl --user start   study-timelapse-worker
systemctl --user stop    study-timelapse-worker
systemctl --user restart study-timelapse-worker
```

## Deploy and rollback

```bash
# deploy (from the Mac)
./scripts/deploy-ubuntu-worker.sh
ssh <host> 'systemctl --user restart study-timelapse-worker'

# what is deployed
ssh <host> 'cat ~/study-timelapse-worker/current/REVISION'

# rollback: check out the previous commit locally and redeploy
git checkout <previous-sha> -- src/ubuntu-worker
./scripts/deploy-ubuntu-worker.sh
```

The queue database, models, spool and config are excluded from rsync, so a
deploy never destroys in-flight work.

## Queue inspection

```bash
DB=~/study-timelapse-worker/state/pipeline.db

# state breakdown
sqlite3 "$DB" 'SELECT state, COUNT(*) FROM chunks GROUP BY state;'

# stuck / failed work
sqlite3 "$DB" "SELECT session_id, segment_index, chunk_index, attempts, error_class,
               substr(error_message,1,80) FROM chunks WHERE state='DEAD_LETTER';"

# per-session progress
sqlite3 "$DB" "SELECT state, COUNT(*) FROM chunks WHERE session_id='<sid>' GROUP BY state;"

# aggregation units
sqlite3 "$DB" 'SELECT aggregation_key, state, attempts FROM aggregations;'
```

Requeue dead-lettered chunks after fixing the underlying cause (the source
chunks must still exist — check the cleanup delay has not elapsed):

```bash
sqlite3 "$DB" "UPDATE chunks SET state='RECEIVED', attempts=0, next_attempt_at=0
               WHERE state='DEAD_LETTER' AND error_class!='chunk_gone';"
systemctl --user restart study-timelapse-worker
```

## Recovery scenarios

**Worker was offline for a while.** Pub/Sub retains messages for 7 days. On
start, the subscriber drains the backlog into SQLite and the chunk loop works
through it. Source chunks survive for `CHUNK_CLEANUP_DELAY_SEC` (default 24h)
after a session finishes, so anything inside that window is still recoverable.
Beyond it, chunks are gone and those entries dead-letter as `chunk_gone` — this
is recorded, never silently ignored.

**Chunks are being dead-lettered as `chunk_gone`.** Cleanup won the race.
Increase `CHUNK_CLEANUP_DELAY_SEC` on the Cloud Run service and redeploy.

**SLO demotion.** Check `demoted` and `current_profile` in the health endpoint.
Demotion is one-way by design. To restore quality, fix the cause, re-run
`./scripts/ubuntu-benchmark-vlm.sh`, set `VLM_PROFILE` accordingly, then:

```bash
sqlite3 "$DB" "DELETE FROM meta WHERE key IN ('vlm_profile','vlm_demoted');"
systemctl --user restart study-timelapse-worker
```

**LLM OOM.** The ladder handles it automatically and records `fallback_used`
and `fallback_reason` in the report. It degrades context 8192 -> 4096, then
enables CPU offload, then drops to `gemma-3-12b-it`. Persistent fallback means
the 27B does not fit this configuration; either accept the 12B by setting
`LLM_MODEL_ID=google/gemma-3-12b-it`, or investigate what else is holding VRAM
on GPU1.

**GPU renumbered after a reboot.** The worker records GPU UUIDs and logs a
warning when the topology changes. Verify with `nvidia-smi -L` and correct
`VLM_GPU` / `LLM_GPU`.

**Orphaned model process holding VRAM.** Should not happen — subprocesses run in
their own process group and are terminated as a group. If one does appear,
identify it before acting:

```bash
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
readlink -f /proc/<PID>/exe   # confirm it is ours before signalling
kill -TERM <PID>
```

Never use `killall python` or a broad `pkill -f python` on this host — it runs
other people's research jobs.

## Services stopped for this pipeline

The GPUs were freed on 2026-07-20. Nothing was uninstalled or deleted; the
processes were stopped with SIGTERM and exited cleanly in 3 seconds.

| What | Restart |
|---|---|
| SO-101/Pi0.5 policy server (was :50051, 16.7GB) | `python /home/suzukilab/so101-pi05-infer/scripts/policy_server_pi05_fp32.py --host 100.74.222.81 --port 50051` |
| voice_memory worker (2.3GB) | `cd ~/voice-memory/backend && ~/miniforge3/envs/voice_memory/bin/python -m app.workers.worker` |
| voice_memory API (was :8787) | `cd ~/voice-memory/backend && ~/miniforge3/envs/voice_memory/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787 --workers 1` |
| ollama.service (:11434) | `sudo systemctl start ollama` — left running; holds no VRAM with no model loaded |

Exact recorded state, including full argv:
`~/study-timelapse-worker/state/gpu-restore-20260720-121211.txt`

Neither the conda environments nor any model weights for these projects were
touched.

## Authentication

The worker uses **ADC** at `~/.config/gcloud/application_default_credentials.json`
(mode 600, owned by `suzukilab`, quota project `vla-test1`). `worker.env`
deliberately does not set `GOOGLE_APPLICATION_CREDENTIALS`.

Verify:

```bash
gcloud auth application-default print-access-token >/dev/null && echo ok
```

If the worker starts logging 401/403 from GCS or Pub/Sub, ADC has expired or
been revoked — re-run `gcloud auth application-default login` on the host.

The worker impersonates `study-timelapse-worker@vla-test1` via
`IMPERSONATE_SERVICE_ACCOUNT`. ADC mints a short-lived token for it on demand,
so **no service account key file exists anywhere**.

Its permissions:

| Role | Scope |
|---|---|
| `roles/pubsub.subscriber` | the chunk subscription |
| `roles/storage.objectViewer` | the bucket |
| `roles/storage.objectCreator` | the bucket |
| `roles/storage.objectAdmin` | **conditional**: `resource.name.endsWith('.json')` |

The conditional binding is not optional and the reason is not obvious: **GCS
requires `storage.objects.delete` to overwrite an existing object.** With
create-only permission the first `status.json` write succeeds and every
subsequent one returns 403, silently freezing the UI's progress display. This
was only caught because a re-run happened to overwrite rather than create.

The condition restricts overwrite/delete to `.json`, so source chunks
(`.webm`), timelapses (`.mp4`) and thumbnails (`.jpg`) can never be destroyed —
which is the property that actually matters.

Known limitation: `metadata.json` and `profile.json` also end in `.json`, so
they fall inside the condition. The worker has no code path that writes or
deletes them, and `tests/test_no_delete_capability.py` enforces that there is
no delete call at all — but at the IAM layer this is wider than intended. IAM
conditions cannot express the needed pattern (`resource.name.contains()` is
rejected, and the variable uid sits mid-path so `startsWith` cannot reach the
`analysis/` segment). Tightening further would require a separate bucket for
analysis output.

Verify the boundary holds:

```bash
SA=study-timelapse-worker@vla-test1.iam.gserviceaccount.com
# expected: succeeds
echo '{}' | gcloud storage cp - gs://BUCKET/users/UID/sessions/SID/analysis/status.json \
  --impersonate-service-account=$SA
# expected: denied, object still present
gcloud storage rm gs://BUCKET/users/UID/sessions/SID/segments/0/chunks/0.webm \
  --impersonate-service-account=$SA
```

## Things that need a human

These cannot be done non-interactively and are deliberately not automated:

- `sudo systemctl stop ollama` — sudo password
- `sudo loginctl enable-linger suzukilab` — needed for the worker to survive
  logout
- Re-running `hf auth login` if the Hugging Face token is revoked
- Re-running `gcloud auth application-default login` when ADC expires

Never paste a token or password into a command that gets logged, into source, or
into a chat transcript.
