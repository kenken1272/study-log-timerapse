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
    parser.add_argument(
        "--fallback",
        action="append",
        help="Smaller model to try if the configured one misses the SLO at every "
             "profile. Repeatable, tried in order.",
    )
    parser.add_argument("--out", type=Path, default=Path("benchmark-vlm.json"))
    args = parser.parse_args()

    settings = load_settings()
    work_dir = settings.spool_dir / "benchmark"
    work_dir.mkdir(parents=True, exist_ok=True)

    # Candidate ladder: the configured model first, then the documented smaller
    # fallback. Never silently substitute — every attempt is recorded.
    candidates = [settings.vlm_model_id]
    for fallback in args.fallback or []:
        if fallback not in candidates:
            candidates.append(fallback)

    all_results: list[dict] = []
    chosen_model: str | None = None
    chosen_profile: str | None = None
    load_seconds = 0.0
    runtime = None

    for model_id in candidates:
        print(f"\n=== {model_id} ===")
        print(f"GPU state before load: {gpu_manager.memory_used_mib()}")

        if runtime is not None:
            # Free the previous candidate before loading the next.
            runtime.unload()
            time.sleep(3)

        runtime = TransformersVlmRuntime(
            model_id, settings.vlm_gpu, settings.vlm_revision,
            settings.vlm_max_new_tokens, settings.vlm_architecture,
        )
        try:
            load_started = time.perf_counter()
            runtime.load()
            load_seconds = time.perf_counter() - load_started
            runtime.warmup()
        except Exception as error:
            print(f"  load FAILED: {error}")
            all_results.append({"model": model_id, "error": str(error), "json_valid": False})
            continue

        print(f"loaded and warmed in {load_seconds:.1f}s")
        print(f"GPU state after load:  {gpu_manager.memory_used_mib()}")

        for profile in PROFILE_ORDER:
            runs = []
            failed = False
            for attempt in range(args.repeat):
                try:
                    run = measure(runtime, args.chunk, profile, work_dir)
                except Exception as error:
                    print(f"  {profile} attempt {attempt + 1}: FAILED ({error})")
                    runs.append(
                        {"model": model_id, "profile": profile,
                         "error": str(error), "json_valid": False}
                    )
                    failed = True
                    break
                run["model"] = model_id
                runs.append(run)
                print(
                    f"  {profile} attempt {attempt + 1}: {run['total_ms']}ms "
                    f"({run['resolution']}, {run['frame_count']} frames, "
                    f"{run['peak_vram_mib']}MiB)"
                )
            all_results.extend(runs)

            if failed:
                # An error is not an SLO miss. Trying a lighter profile will not
                # fix a model that returns unusable output, but the distinction
                # has to survive into the report.
                continue

            worst = max(run["total_ms"] for run in runs)
            # Every run must clear the SLO, not just the median — a single 26s
            # chunk in production is a user-visible stall.
            if worst <= settings.vlm_slo_ms:
                chosen_model, chosen_profile = model_id, profile
                print(f"==> {profile} meets the {settings.vlm_slo_ms}ms SLO (worst {worst}ms)")
                break
            print(
                f"    {profile} worst {worst}ms exceeds {settings.vlm_slo_ms}ms; "
                "trying a lighter profile"
            )

        if chosen_profile is not None:
            break

        errored = [
            run for run in all_results
            if run.get("model") == model_id and run.get("error")
        ]
        if errored and not any(
            run.get("model") == model_id and "total_ms" in run for run in all_results
        ):
            # Every attempt raised: this is a correctness problem, not a speed
            # one, and reporting it as "too slow" would send the next person
            # chasing the wrong thing.
            print(f"--- {model_id} produced no usable output at any profile "
                  f"({errored[0]['error'][:100]})")
        else:
            print(f"--- {model_id} met no profile within the SLO")

    payload = {
        "candidates": candidates,
        "quantization": runtime.quantization if runtime else None,
        "architecture": runtime.architecture if runtime else None,
        "gpu": settings.vlm_gpu,
        "slo_ms": settings.vlm_slo_ms,
        "load_seconds": round(load_seconds, 1),
        "chosen_model": chosen_model,
        "chosen_profile": chosen_profile,
        "runs": all_results,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nwrote {args.out}")

    if chosen_profile is None:
        timed = [run for run in all_results if "total_ms" in run]
        if timed:
            print("WARNING: no model/profile combination met the SLO.")
        else:
            print("WARNING: no attempt produced usable output — every run errored.")
            print("         This is a correctness bug, not a performance result.")
        print("         Do not enable the service on these numbers.")
        return 1

    print(f"\nSet in config/worker.env:")
    print(f"  VLM_MODEL_ID={chosen_model}")
    print(f"  VLM_PROFILE={chosen_profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
