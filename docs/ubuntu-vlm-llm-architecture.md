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
| Frames, not video, to the VLM | Gemma 3 is an image+text model. Handing it a WebM is not a supported input. |
| Aggregation model unloaded after each burst | Returns VRAM to the OS immediately, so the VLM gets its card back within seconds. |

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
| VLM | `VLM_GPU=0` | Resident. Loading per chunk would blow the SLO alone. |
| LLM | `LLM_GPU=1` | Loaded per burst, unloaded straight after. CPU offload only if it will not otherwise fit. |

The two models live on separate cards, so the aggregation burst never stalls
chunk processing and no backlog builds up. Chunks that arrive during a burst
simply wait in SQLite.

Exclusion is a `filelock` on disk, not an in-process boolean, so a second worker
instance cannot double-load a card.

## Model policy

Both models are Google Gemma 3, run through Transformers with identical
quantization and dtype. One dependency stack, one quantization path, one dtype
policy — nothing in this pipeline uses llama.cpp, GGUF, or any Meta model.

| Role | Model | Device | Residency |
|---|---|---|---|
| Per 30s chunk | `google/gemma-3-12b-it` | GPU0 (`VLM_GPU`) | resident |
| Per 30 min / final | `google/gemma-3-27b-it` | GPU1 (`LLM_GPU`) | on demand |

Both: `Gemma3ForConditionalGeneration`, bitsandbytes NF4 4-bit, **float16**
compute. Gemma 3 is natively bf16 and most published guidance assumes it, but
the TITAN RTX is Turing (sm_75) and has no bf16 path — so fp16 is not a
preference here, it is the only option.

Model ids are environment variables (`VLM_MODEL_ID`, `LLM_MODEL_ID`), so
swapping either is config, not code.

The VLM stays loaded because a per-chunk load would blow the 25s SLO by itself.
The aggregation model is the opposite: loaded for a burst and unloaded
immediately after — in a `finally`, so it releases on success, OOM and crash
alike — because holding ~18GB idle on GPU1 buys nothing and the VLM needs its
own card back within seconds.

`VLM_ARCHITECTURE` (`auto|gemma3|mllama`) still exists and the Mllama path is
still implemented. That is deliberate: it costs almost nothing, and it means a
Llama vision model could be scored on the same chunk with the same prompt and
schema for comparison. `auto` refuses to guess. Note that `paligemma-3b`
contains the substring `gemma-3`; PaliGemma is a different architecture, is out
of scope, and is rejected by name. It is present in the HF cache on this host
from other lab work, so that check is load-bearing rather than theoretical.

### OOM ladder

Bounded, each rung attempted at most once, and always recorded:

1. `gemma-3-27b-it`, context 8192, GPU only
2. same, context 4096
3. same, context 4096, CPU offload into the host's ~125GiB of RAM
4. `gemma-3-12b-it`

OOM is classified from the exception type, not by matching strings in stderr —
misclassifying a config error as OOM would silently downgrade the model.
`requested_model` always names what was asked for and `used_model` what actually
ran, so a quietly degraded report is visible rather than invisible.

Context starts at 8192 rather than Gemma 3's full 128K. A 60-chunk window is
nowhere near that, and the KV cache cost of a wide context is real.

## Privacy and safety

- The bucket stays private. Analysis is read server-side and returned as JSON;
  no object is ever made public.
- The worker authenticates with **ADC** on the Ubuntu host
  (`~/.config/gcloud/application_default_credentials.json`, mode 600, quota
  project `vla-test1`). No key file is copied, displayed, or committed.
- **Caveat worth knowing:** ADC belongs to a human account, so the worker
  inherits that account's permissions — including the ability to delete bucket
  objects. The original design put a least-privilege service account here
  (`study-timelapse-worker@`, subscribe + object read + object create, no
  delete), and that account still exists unused. With ADC, nothing at the IAM
  layer prevents the worker from destroying a user's footage; the only thing
  that does is the absence of any delete call in the code, enforced by
  `tests/test_no_delete_capability.py`. Switching back to the service account
  restores defence in depth.
- Spooled video is written with `umask 077` and deleted as soon as its analysis
  is safely in GCS.
- Object names contain a uid and are logged at DEBUG only. Log output is passed
  through a redacting formatter for bearer tokens, HF tokens, private keys and
  signed-URL signatures.
- The health endpoint binds `127.0.0.1` only.
- No face recognition, identification, or emotion inference. Concentration is
  presented in the UI as an estimate from observable behaviour.
