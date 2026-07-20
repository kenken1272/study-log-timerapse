"""Measure end-to-end chunk latency per profile and pick one that meets the SLO.

The pass criterion is warm end-to-end time for a whole chunk — download, frame
extraction, inference, validation — not raw model time. Model load happens once
at startup in production, so it is excluded here by warming up first.

Usage:
    python -m tools.benchmark_vlm --chunk /path/to/chunk.webm [--repeat 3]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from app import gpu_manager
from app.settings import PROFILE_ORDER, load_settings
from app.video_frames import extract_frames
from app.vlm_runtime import TransformersVlmRuntime


def measure(runtime, chunk: Path, profile: str, work_dir: Path) -> dict:
    started = time.perf_counter()

    extract_started = time.perf_counter()
    frames = extract_frames(chunk, profile, work_dir / profile)
    extract_ms = int((time.perf_counter() - extract_started) * 1000)

    result = runtime.analyze(frames)
    total_ms = int((time.perf_counter() - started) * 1000)

    return {
        "profile": profile,
        "frame_count": len(frames.paths),
        "resolution": f"{frames.width}x{frames.height}",
        "source_resolution": f"{frames.source_width}x{frames.source_height}",
        "frame_extract_ms": extract_ms,
        "vlm_preprocess_ms": result.preprocess_ms,
        "vlm_generate_ms": result.generate_ms,
        "json_validate_ms": result.validate_ms,
        "total_ms": total_ms,
        "peak_vram_mib": result.peak_vram_mib,
        "json_valid": True,
        "concentration_score": result.metrics.concentration_score,
        "summary": result.metrics.status_summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunk", required=True, type=Path)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--out", type=Path, default=Path("benchmark-vlm.json"))
    args = parser.parse_args()

    settings = load_settings()
    work_dir = settings.spool_dir / "benchmark"
    work_dir.mkdir(parents=True, exist_ok=True)

    print(f"GPU state before load: {gpu_manager.memory_used_mib()}")
    runtime = TransformersVlmRuntime(
        settings.vlm_model_id, settings.vlm_gpu, settings.vlm_revision,
        settings.vlm_max_new_tokens,
    )
    load_started = time.perf_counter()
    runtime.load()
    load_seconds = time.perf_counter() - load_started
    runtime.warmup()
    print(f"model loaded and warmed in {load_seconds:.1f}s")
    print(f"GPU state after load:  {gpu_manager.memory_used_mib()}")

    results: list[dict] = []
    chosen: str | None = None

    for profile in PROFILE_ORDER:
        runs = []
        failed = False
        for attempt in range(args.repeat):
            try:
                run = measure(runtime, args.chunk, profile, work_dir)
            except Exception as error:
                print(f"  {profile} attempt {attempt + 1}: FAILED ({error})")
                runs.append({"profile": profile, "error": str(error), "json_valid": False})
                failed = True
                break
            runs.append(run)
            print(
                f"  {profile} attempt {attempt + 1}: {run['total_ms']}ms "
                f"({run['resolution']}, {run['frame_count']} frames, "
                f"{run['peak_vram_mib']}MiB)"
            )
        results.extend(runs)

        if failed:
            continue

        worst = max(run["total_ms"] for run in runs)
        # Every run must clear the SLO, not just the median — a single 26s chunk
        # in production is a user-visible stall.
        if worst <= settings.vlm_slo_ms:
            chosen = profile
            print(f"==> {profile} meets the {settings.vlm_slo_ms}ms SLO (worst {worst}ms)")
            break
        print(f"    {profile} worst {worst}ms exceeds {settings.vlm_slo_ms}ms; trying lighter")

    payload = {
        "model": settings.vlm_model_id,
        "quantization": runtime.quantization,
        "gpu": settings.vlm_gpu,
        "slo_ms": settings.vlm_slo_ms,
        "load_seconds": round(load_seconds, 1),
        "chosen_profile": chosen,
        "runs": results,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nwrote {args.out}")

    if chosen is None:
        print("WARNING: no profile met the SLO. Investigate before enabling the service.")
        return 1

    print(f"Set VLM_PROFILE={chosen} in config/worker.env")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
