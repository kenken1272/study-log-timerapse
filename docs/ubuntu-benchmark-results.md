# Benchmark results

Host: slabPCX, 2× NVIDIA TITAN RTX 24GB (sm_75), driver 595.71.05, CUDA 13.2
Torch: 2.4.1+cu121 · ffmpeg 6.1.1 · Python 3.12.3

## Headline results

| | |
|---|---|
| VLM adopted | **google/gemma-3-4b-it**, Profile A `original_8`, **19.7s** |
| VLM rejected | google/gemma-3-12b-it — 28.4s at its *lightest* profile |
| Compute dtype | **float32** (fp16 is unusable — see below) |
| Quantization | bitsandbytes NF4 4-bit |

## float16 does not work with Gemma 3 on this hardware

The plan called for fp16, correctly reasoning that Turing (sm_75) has no bf16
path. Measured, fp16 fails outright:

| compute dtype | logits | generated | decoded |
|---|---|---|---|
| float16 | **NaN** (absmax=nan) | 512 tokens (all special) | `''` |
| float32 | finite, absmax 65.68 | 191 tokens, stops at EOS | valid JSON |

Gemma 3 is a bf16-native model whose activations overflow fp16's range. Weights
stay 4-bit NF4; only the compute dtype changes. Every benchmark attempt failed
identically under fp16, which initially looked like an SLO problem and was not —
worth remembering, because "all profiles failed" is exactly what a genuinely
slow model looks like too.

## VLM: measured, warm, 3 runs each

| Model | Profile | Resolution | Frames | Extract | Generate | **Total** | Peak VRAM |
|---|---|---|---:|---:|---:|---:|---:|
| gemma-3-12b-it | A `original_8` | 1920×1080 | 8 | 2.4s | 29.1s | 32.0–32.5s | 14127 MiB |
| gemma-3-12b-it | B `reduced_720p_8` | 1280×720 | 8 | 2.5s | 29.4s | 32.4–32.5s | 14127 MiB |
| gemma-3-12b-it | C `one_third_8` | 640×360 | 8 | 2.5s | 29.3s | 32.1–32.3s | 14127 MiB |
| gemma-3-12b-it | D `one_third_6` | 640×360 | 6 | 2.5s | 25.8s | 28.4–28.6s | 14127 MiB |
| **gemma-3-4b-it** | **A `original_8`** | **1920×1080** | **8** | **2.4s** | **16.8s** | **19.7s** | **11677 MiB** |

### Downscaling is useless for Gemma 3

1080p, 720p and 360p all generate in ~29.3s — within noise of each other. Gemma
3's vision encoder resizes every input to a fixed size and emits a fixed token
count per image, so input resolution never reaches the model. **Profiles B and C
do nothing for this model family.** They remain implemented because they are
correct for architectures that do scale with input resolution, but they must not
be relied on here.

Only frame *count* matters: 8→6 frames saved 3.5s, about **1.75s per frame**.

### Why the 12B was rejected rather than tuned

Three levers were measured, not assumed:

- **Resolution** — no effect at all (above).
- **Token cap** — not binding. The model emits 191 tokens and stops at EOS, far
  under the 512 cap, so lowering `max_new_tokens` cannot help. (154ms/token in
  fp32 is simply what a 12B costs on this card.)
- **Frame count** — at 1.75s/frame, reaching 25s from 32.0s needs ~4 frames
  total, which lands *exactly* on the limit and halves temporal coverage of the
  30s chunk.

The 4B at full 1080p and 8 frames clears the SLO by 5.3s with no quality
compromise in sampling. That is a better trade than a 12B run at 4 frames.

## Frame extraction

Flat at **~2.4–2.6s regardless of profile** — VP9 decode dominates, and
downscaling does not reduce it. This is ~12% of the 25s budget and is paid on
every chunk before the model starts.

## End-to-end plumbing (verified with mock models)

| Stage | Time |
|---|---|
| GCS download | 122–767 ms |
| Frame extraction | 2407–2631 ms |
| Analysis upload | 89–333 ms |
| Non-model overhead | **~3.0–3.5s** |

Verified in the same run: duplicate Pub/Sub delivery produced no second
analysis; out-of-order arrival (3,1,2) was reassembled in timeline order; the
worker's own `analysis/` writes were ignored; session end triggered exactly one
final aggregation; `coverage_ratio` and the gap warning were computed from the
real span rather than taken from the model.

## Caveat on quality

The benchmark chunk is an ffmpeg `testsrc` colour-bar pattern, **not real study
footage**. Timing and VRAM figures are valid; the quality comparison is not.
For the record, on this synthetic input the 12B claimed "人物の存在は確認できる"
(a person is present) when no person exists in a colour-bar pattern, while the
4B described it accurately as a test screen. That is a single sample of
synthetic data and is not evidence that the 4B is the better analyst — real
footage is needed before saying anything about quality.

## LLM

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
