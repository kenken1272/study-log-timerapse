"""Run one aggregation and exit. Invoked as a subprocess by the worker.

Why a subprocess rather than an in-process call:

1. **VRAM is actually returned.** Measured on this host, unloading the model
   in-process leaves ~11.2GB still reserved (`torch_alloc=8MiB` but
   `torch_reserved=11244MiB`) — `empty_cache()` does not give it back, so GPU1
   stayed occupied even while idle. Process exit releases it unconditionally.

2. **A CUDA fault cannot reach the VLM.** CUDA errors are sticky per process
   and cross devices: in production one Xid 13 on GPU1 during aggregation was
   followed two seconds later by the VLM failing on GPU0 with valid input.
   Isolating the bursty, less latency-critical model means the resident VLM —
   which has a 25s SLO to hold every 30 seconds — cannot be taken down by it.

Reads a JSON job on stdin, writes a JSON result on stdout. Exit codes:
  0  success                 2  bad input / model failure
  70 fatal CUDA error        3  OOM after the whole ladder
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import cuda_health  # noqa: E402
from app.llm_runtime import (  # noqa: E402
    LlmConfig,
    LlmFailed,
    TransformersLlmRuntime,
    build_fallback_ladder,
)


def main() -> int:
    try:
        job = json.loads(sys.stdin.read())
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"bad job payload: {error}"}), file=sys.stderr)
        return 2

    prompt = job["prompt"]
    gpu_index = int(job["gpu_index"])
    compute_dtype = job.get("compute_dtype", "float32")
    ladder = [LlmConfig(**rung) for rung in job["ladder"]]

    runtime = TransformersLlmRuntime(gpu_index, job.get("revision"), compute_dtype)
    try:
        output = runtime.generate(ladder, prompt)
    except cuda_health.FatalCudaError as error:
        print(json.dumps({"error": str(error), "fatal_cuda": True}), file=sys.stderr)
        return cuda_health.FATAL_CUDA_EXIT_CODE
    except LlmFailed as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - the exit code is the contract
        if cuda_health.is_fatal_cuda_error(error):
            print(json.dumps({"error": str(error), "fatal_cuda": True}), file=sys.stderr)
            return cuda_health.FATAL_CUDA_EXIT_CODE
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2

    json.dump(
        {"payload": output.payload, "runtime": output.runtime.model_dump()},
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
