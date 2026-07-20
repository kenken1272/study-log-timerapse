# Benchmark results

Host: slabPCX, 2× NVIDIA TITAN RTX 24GB (sm_75), driver 595.71.05, CUDA 13.2
Torch: 2.4.1+cu121 · ffmpeg 6.1.1 · Python 3.12.3

## Status

| Stage | State |
|---|---|
| Pipeline plumbing (Pub/Sub → queue → frames → GCS → API) | **verified end-to-end** 2026-07-20 |
| Frame extraction, all four profiles | **measured** |
| VLM latency / VRAM | **blocked** — model not downloaded (Meta licence) |
| LLM latency / VRAM / fallback | **blocked** — model not downloaded |

The model numbers below are the ones that decide `VLM_PROFILE` and
`LLM_GPU_LAYERS`. Until they are measured, the config carries defaults, not
validated values. Do not treat the defaults as benchmarked.

## GPU baseline

Measured after stopping the pre-existing workloads (see
[ubuntu-operations.md](ubuntu-operations.md)):

```
GPU0: 6 MiB / 24576 MiB    compute processes: 0
GPU1: 204 MiB / 24576 MiB  (Xorg only)
```

Both cards report `sm_75`. Turing has **no bf16 path**, which is why the VLM
runs fp16 compute under 4-bit NF4 rather than the bf16 default that most
Llama-3.2-Vision examples use.

## Frame extraction (measured)

Synthetic 30s 1920×1080 VP9 chunk, single ffmpeg pass, no re-encode of the
source. Mac figures shown for comparison; Ubuntu is the one that matters.

| Profile | Frames | Output size | Extract (Ubuntu) | Extract (Mac) |
|---|---|---|---|---|
| `original_8` | 8 | 1920×1080 | ~2410–2520 ms | 372 ms |
| `reduced_720p_8` | 8 | 1280×720 | not yet measured | 366 ms |
| `one_third_8` | 8 | 640×360 | not yet measured | 361 ms |
| `one_third_6` | 6 | 640×360 | not yet measured | 354 ms |

Sample offsets for `original_8` are 1.88 / 5.62 / 9.38 / 13.12 / 16.88 / 20.62 /
24.38 / 28.12 s — evenly spaced, none on a boundary.

**This is the significant finding so far:** frame extraction alone costs roughly
**2.4–2.5 s** of the 25 s budget on the real host, about 8× the Mac. Scaling
barely changed cost on the Mac, which suggests VP9 decode dominates and the
lighter profiles will save less than their pixel counts imply. If the VLM turns
out to need more than ~22 s, reducing frame *count* (`one_third_6`) is likely to
help more than reducing resolution.

## End-to-end plumbing (measured, mock models)

Four chunks through the real pipeline with `WORKER_DRY_RUN=1`:

| Stage | Time |
|---|---|
| GCS download | 122–767 ms (first includes connection setup) |
| Frame extraction | 2407–2518 ms |
| VLM (mock) | 100 ms |
| Analysis upload | 255–333 ms |
| **Total** | **2801–3572 ms** |

Non-model overhead is therefore about **3.0–3.5 s**, leaving roughly **21.5 s**
for real inference inside the 25 s SLO.

Verified in the same run:

- duplicate Pub/Sub delivery with an identical generation produced no second
  analysis
- chunks uploaded out of order (3, 1, 2) were reassembled in timeline order
- the worker's own writes under `analysis/` were ignored, not re-ingested
- session end via `metadata.json` triggered exactly one final aggregation
- `coverage_ratio` 0.571 and a Japanese gap warning were generated from the
  real span, not from the model's own claim

## To run the real benchmarks

Once the weights are in place:

```bash
./scripts/ubuntu-benchmark-vlm.sh /home/suzukilab/test-chunk.webm
./scripts/ubuntu-benchmark-llm.sh
```

Record here:

**VLM** — profile, frame count, input resolution, download / extract / model
time, total, peak VRAM, JSON validity, qualitative sanity of the description.
The pass criterion is warm end-to-end total ≤ 25000 ms on **every** repeat, not
the median.

**LLM** — model file size, GPU offload config, context size, prompt and output
tokens, load time, inference time, peak VRAM on GPU0 and GPU1, host RAM, schema
validity, whether a fallback fired. Note the real file size: 70B Q2_K is
commonly ~26 GB rather than the 22 GB often quoted.
