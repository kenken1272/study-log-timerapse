"""Measure the aggregation model on a realistic 30-minute window.

Generates synthetic chunk analyses (no real user footage involved), builds the
production prompt, and records load time, inference time, VRAM on both cards,
schema validity and any fallback.

Usage:
    python -m tools.benchmark_llm [--chunks 60] [--context 8192] [--gpu-layers 20]
"""

from __future__ import annotations

import argparse
import json
import random
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import aggregator, gpu_manager
from app.llm_runtime import LlamaCppRuntime, LlmConfig, build_fallback_ladder
from app.settings import load_settings

BASE = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)


def synthetic_payloads(count: int) -> list[dict]:
    """Plausible but entirely fabricated observation log."""
    random.seed(42)
    activities = ["writing", "reading", "typing", "idle", "phone"]
    payloads = []
    for index in range(count):
        # Drift downward over the window so trend detection has something real.
        score = max(10, min(95, int(85 - index * 0.6 + random.randint(-10, 10))))
        activity = random.choice(activities) if score < 50 else random.choice(activities[:3])
        payloads.append(
            {
                "chunk_started_at": (BASE + timedelta(seconds=index * 30)).isoformat(),
                "segment_index": 0,
                "chunk_index": index,
                "metrics": {
                    "concentration_score": score,
                    "concentration_level": "high" if score >= 70 else "medium" if score >= 40 else "low",
                    "presence": "present" if activity != "idle" else "unclear",
                    "primary_activity": activity,
                    "phone_use": activity == "phone",
                    "away_from_desk": False,
                    "posture_change_count": random.randint(0, 3),
                    "confidence": round(random.uniform(0.4, 0.9), 2),
                    "status_summary": f"{activity} が観察された。",
                },
            }
        )
    return payloads


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunks", type=int, default=60)
    parser.add_argument("--context", type=int, default=None)
    parser.add_argument("--gpu-layers", type=int, default=None)
    parser.add_argument("--out", type=Path, default=Path("benchmark-llm.json"))
    args = parser.parse_args()

    settings = load_settings()
    model_path = Path(settings.llm_model_path)
    if not model_path.exists():
        print(f"error: LLM_MODEL_PATH does not exist: {model_path}")
        return 1

    size_gib = model_path.stat().st_size / 1024**3
    print(f"model file: {model_path.name} ({size_gib:.1f} GiB)")
    print(f"GPU before: {gpu_manager.memory_used_mib()}")

    primary = LlmConfig(
        model_path=str(model_path),
        display_name=settings.llm_requested_model,
        quantization="Q2_K",
        context_size=args.context or settings.llm_context_size,
        gpu_layers=args.gpu_layers if args.gpu_layers is not None else settings.llm_gpu_layers,
        max_output_tokens=settings.llm_max_output_tokens,
    )
    ladder = build_fallback_ladder(primary, [])

    payloads = synthetic_payloads(args.chunks)
    plan = aggregator.WindowPlan(
        session_id="benchmark",
        uid="benchmark",
        analysis_type="window",
        start=BASE,
        end=BASE + timedelta(minutes=30),
        rows=[],
        aggregation_key="benchmark|window",
    )

    runtime = LlamaCppRuntime(settings.llm_binary, settings.llm_gpu)
    started = time.perf_counter()
    schema_valid = True
    error: str | None = None
    analysis = None
    try:
        analysis = aggregator.build_analysis(plan, payloads, runtime, ladder)
    except Exception as exception:
        schema_valid = False
        error = str(exception)
        print(f"FAILED: {exception}")
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    usage = gpu_manager.memory_used_mib()
    print(f"GPU after:  {usage}")

    payload = {
        "model_file": model_path.name,
        "model_size_gib": round(size_gib, 2),
        "context_size": primary.context_size,
        "gpu_layers": primary.gpu_layers,
        "chunk_count": args.chunks,
        "total_ms": elapsed_ms,
        "schema_valid": schema_valid,
        "error": error,
        "gpu_memory_used_mib": usage,
        "runtime": analysis.runtime.model_dump() if analysis else None,
        "summary": analysis.summary if analysis else None,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nwrote {args.out}")

    if analysis:
        print(f"used model:   {analysis.runtime.used_model}")
        print(f"fallback:     {analysis.runtime.fallback_used}")
        print(f"inference:    {analysis.runtime.inference_ms}ms")
        print(f"summary:      {analysis.summary[:120]}")
    return 0 if schema_valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
