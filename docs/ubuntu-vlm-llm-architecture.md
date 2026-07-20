# Ubuntu VLM/LLM analysis pipeline — architecture

Adds asynchronous, GPU-local analysis of study recordings alongside the existing
Gemini analysis. Nothing about recording, chunk upload, IndexedDB resend, signed
URLs, timelapse generation, Firebase auth, or the Gemini path changes behaviour.

## Why this shape

| Decision | Reason |
|---|---|
| Pub/Sub **pull**, not push | The Ubuntu host is behind Tailscale with no public HTTPS endpoint. Pull needs only outbound connectivity, and Pub/Sub buffers events while the box is down. |
| SQLite queue between Pub/Sub and inference | Acking after a durable commit means a crash mid-inference costs a redelivery, not a chunk. |
| Idempotency key includes GCS `generation` | The same object path can legitimately be re-uploaded. Path alone cannot tell a re-upload from a redelivery. |
| Deferred chunk deletion | Previously chunks were deleted inline the moment the timelapse was built, so any Ubuntu downtime meant permanent data loss for analysis. |
| Frames, not video, to the VLM | Llama-3.2-Vision is an image+text model. Handing it a WebM is not a supported input. |
| Aggregation model as a subprocess | Guarantees VRAM returns to the OS when the burst ends, so the VLM gets its card back. |

## Data flow

```
browser
  └─ signed PUT ─▶ gs://<bucket>/users/{uid}/sessions/{sid}/segments/{seg}/chunks/{n}.webm
                        │
                        ├─▶ [existing] Cloud Tasks ▶ Cloud Run ▶ ffmpeg timelapse
                        │                                  └─▶ delayed cleanup task (24h)
                        │
                        └─▶ OBJECT_FINALIZE ▶ Pub/Sub topic
                                                  │ pull
                                                  ▼
                                          SQLite durable queue
                                                  │
                            download ▶ 8 frames ▶ VLM ▶ analysis/chunks/{seg}/{n}.json
                                                  │
                        30-min window / session end ▶ LLM ▶ analysis/windows/*.json
                                                                analysis.json
                                                  │
                                    Next.js /api/sessions/{id}/local-analysis
                                                  ▼
                                        session detail — "ローカルAI分析"
```

## GCS layout

Existing (unchanged):

```
users/{uid}/sessions/{sid}/segments/{seg}/chunks/{n}.webm
users/{uid}/sessions/{sid}/metadata.json
users/{uid}/sessions/{sid}/timelapse.mp4
```

Added:

```
users/{uid}/sessions/{sid}/analysis/status.json
users/{uid}/sessions/{sid}/analysis/chunks/{seg}/{n}.json
users/{uid}/sessions/{sid}/analysis/windows/{windowStartIso}.json
users/{uid}/sessions/{sid}/analysis.json
```

The `uid` segment is never omitted, and paths are always built from the uid in
the verified Firebase ID token or from the chunk object name itself — never from
client input.

## Chunk state machine

```
RECEIVED ─▶ DOWNLOADING ─▶ DOWNLOADED ─▶ EXTRACTING ─▶ VLM_RUNNING
                                                          │
                                            VLM_DONE ─▶ UPLOADING ─▶ COMPLETED
      ▲                                                   │
      └────────────── RETRY_WAIT ◀────── failure ─────────┘
                          │
                          └─▶ DEAD_LETTER  (attempts exhausted, or chunk gone)
```

Retries use exponential backoff with full jitter, capped at 10 minutes and
bounded by `MAX_ATTEMPTS`. On restart, anything left in an in-flight state is
rewound to `RECEIVED`; `COMPLETED` and `DEAD_LETTER` are never rewound.

## Ordering

Pub/Sub delivery order carries no information. The timeline is rebuilt on read:
sort by `(segment_index, chunk_index, gcs_time_created)`. Segment index must
lead, because each recording segment restarts `chunk_index` at 0 — sorting on
chunk index alone would interleave a resumed recording with the original.

## Windows

A 30-minute window is an **event-time** span anchored on the first
not-yet-aggregated chunk, closed once wall-clock passes its end. It is not "wait
for 60 chunks": breaks, segment splits, resends and dropped uploads all break
that assumption. 30 minutes of 30-second chunks is at most **60** chunks.

`coverage_ratio` and `missing_chunk_count` are computed locally from the window
span, never taken from the model's own claim about its input.

## GPU allocation

| | Default | Notes |
|---|---|---|
| VLM | `VLM_GPU` | Resident. Loading per chunk would blow the SLO alone. |
| LLM | `LLM_GPU` | Bursty. Layers beyond `LLM_GPU_LAYERS` stay in the host's ~125GiB RAM. |

Two modes were designed for; pick from measurement:

- **Mode A (default)** — LLM on its own card with CPU offload. The VLM keeps
  running throughout, so no chunk backlog builds up.
- **Mode B** — split the LLM across both cards. Requires unloading the VLM,
  taking the exclusive file lock, then reloading and re-warming it afterwards.
  Chunks arriving meanwhile wait in SQLite.

Exclusion is a `filelock` on disk, not an in-process boolean, so a second worker
instance cannot double-load a card. Model subprocesses start in their own
process group and are terminated as a group, so a worker crash cannot orphan a
process holding 20GB of VRAM.

## Model policy

Requested models are fixed; whether they fit is decided by measurement.

- **Per chunk:** `meta-llama/Llama-3.2-11B-Vision-Instruct`, bitsandbytes 4-bit
  NF4, **fp16** compute — the TITAN RTX is Turing (sm_75) and has no bf16 path.
- **Per window:** `Meta-Llama-3-70B-Instruct` Q2_K via llama.cpp. File size is
  verified before download rather than assumed; 70B Q2_K is commonly ~26GB, not
  22GB.

Fallback ladder, bounded and recorded in the output:

1. primary
2. primary at context 4096
3. primary at reduced GPU layers and batch size
4. `Qwen2.5-32B-Instruct` Q4_K_M
5. `Llama-3.1-8B-Instruct` Q6_K

`requested_model` always names what was asked for and `used_model` what actually
ran, so a quietly degraded report is visible rather than invisible. OOM is
classified from actual stderr and exit codes, never guessed — misclassifying a
config error as OOM would silently downgrade the model.

Q2_K is aggressive quantization. Model size is not evidence of output quality:
schema conformance, agreement with the input log, and repetition are all
checked.

## Privacy and safety

- The bucket stays private. Analysis is read server-side and returned as JSON;
  no object is ever made public.
- The worker's service account gets subscribe + object read + object create.
  **No delete permission** — it can never remove a user's footage.
- Spooled video is written with `umask 077` and deleted as soon as its analysis
  is safely in GCS.
- Object names contain a uid and are logged at DEBUG only. Log output is passed
  through a redacting formatter for bearer tokens, HF tokens, private keys and
  signed-URL signatures.
- The health endpoint binds `127.0.0.1` only.
- No face recognition, identification, or emotion inference. Concentration is
  presented in the UI as an estimate from observable behaviour.
