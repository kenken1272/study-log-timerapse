# Ubuntu VLM/LLM analysis worker

Asynchronous analysis of Study Timelapse recordings on the lab GPU box. Reads
the 30-second chunks the web app already uploads to GCS, runs a vision model per
chunk and an aggregation model per 30 minutes, and writes JSON back to GCS for
the app to display.

**This directory is the only source of truth.** The Ubuntu host receives a
versioned copy via `scripts/deploy-ubuntu-worker.sh`; the repository is never
cloned there, and nothing is edited in place on the server.

## Flow

```
browser ──signed PUT──▶ private GCS bucket
                            │ OBJECT_FINALIZE
                            ▼
                       Pub/Sub topic
                            │ pull (outbound only — no inbound port on Ubuntu)
                            ▼
                    SQLite durable queue
                            │
        download ▶ sample frames ▶ VLM ▶ analysis/chunks/*.json
                            │
              30-min window / session end ▶ LLM ▶ analysis.json
                            │
                  Next.js authenticated API ▶ session detail UI
```

Pull rather than push because the box sits behind Tailscale with no public
endpoint, and Pub/Sub retains events while it is offline.

## Layout

| Path | Purpose |
|---|---|
| `app/settings.py` | Environment-driven config and frame profiles |
| `app/schemas.py` | Pydantic models; chunk object-name parsing |
| `app/queue_db.py` | SQLite queue, idempotency, retry/backoff, aggregation claims |
| `app/pubsub_consumer.py` | Pull subscriber; commits then acks |
| `app/gcs_client.py` | Chunk read, analysis write (no delete permission) |
| `app/video_frames.py` | ffmpeg frame sampling, single pass, no re-encode |
| `app/vlm_runtime.py` | Llama-3.2-11B-Vision 4-bit, resident |
| `app/llm_runtime.py` | llama.cpp subprocess with bounded OOM fallback |
| `app/aggregator.py` | Event-time 30-min windows and final report |
| `app/gpu_manager.py` | VRAM accounting, file lock, process-group cleanup |
| `app/main.py` | Orchestration, SLO monitoring, status publishing |
| `tools/` | Benchmarks |

## Setup

All commands run from the Mac repository root.

```bash
# 1. ship the source
./scripts/deploy-ubuntu-worker.sh

# 2. build the venv, install pinned deps + torch, run the tests
scp scripts/ubuntu-preflight.sh suzukilab@100.74.222.81:/tmp/
ssh suzukilab@100.74.222.81 'bash /tmp/ubuntu-preflight.sh'

# 3. fill in credentials — on the host, chmod 600, never committed
#    cp current/.env.example config/worker.env && chmod 600 config/worker.env

# 4. pick a frame profile from measurement, not guesswork
./scripts/ubuntu-benchmark-vlm.sh /home/suzukilab/test-chunk.webm
./scripts/ubuntu-benchmark-llm.sh

# 5. run it
ssh suzukilab@100.74.222.81 'systemctl --user enable --now study-timelapse-worker'
```

Operational commands (logs, restart, rollback, recovery) are in
[`docs/ubuntu-operations.md`](../../docs/ubuntu-operations.md).

## Tests

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q
```

The suite runs without a GPU, without GCP credentials, and without model
weights. Tests that need ffmpeg skip themselves when it is absent.

## Design decisions worth knowing

**"Equal-scale" analysis.** Llama-3.2-Vision takes images, not video, so a 30s
WebM is never handed to it directly. The source chunk in GCS is never modified
or re-encoded; 8 frames are sampled at native resolution, evenly spaced across
the real duration, with each frame's timestamp included in the prompt.

**The 25s SLO.** Measured warm, end-to-end per chunk. Two consecutive misses
demote to a lighter frame profile; a single slow chunk does not. Promotion is
never automatic — it requires re-running the benchmark, so a transient stall
cannot silently lock in degraded quality forever.

**Idempotency includes the GCS generation.** `uid/session/segment/chunk` alone
cannot distinguish a re-uploaded chunk from a redelivered notification. Both
happen.

**Model output is never trusted.** Every response is schema-validated; one
conservative repair pass fixes structural noise only. Invalid output retries
rather than being stored. `coverage_ratio` is computed locally, never taken from
the model.

**Chunk deletion is deferred.** The web app used to delete source chunks
immediately after building the timelapse, which made analysis impossible
whenever this host was behind. Deletion now runs as a delayed Cloud Task
(`CHUNK_CLEANUP_DELAY_SEC`, default 24h). The worker has no delete permission at
all.

**Concentration scores are estimates.** They come from observable surface
behaviour — remaining at the desk, sustained movement, phone use, absence — not
from any measurement of a mental state. The UI says so. No face recognition, no
identification, no emotion inference.
