"""Runtime configuration.

Every value comes from the environment (config/worker.env on the Ubuntu host).
Nothing secret is ever logged or embedded in a default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Frame-sampling profiles, ordered most-expensive first. The calibration step in
# vlm_runtime walks this list downward until a profile meets the SLO.
PROFILE_ORDER = ("original_8", "reduced_720p_8", "one_third_8", "one_third_6")

PROFILE_SPECS: dict[str, dict[str, object]] = {
    "original_8": {"frames": 8, "scale": None},
    "reduced_720p_8": {"frames": 8, "scale": "720p"},
    "one_third_8": {"frames": 8, "scale": "one_third"},
    "one_third_6": {"frames": 6, "scale": "one_third"},
}


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"{name} is not set.")
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # --- GCP ---
    project_id: str
    bucket_name: str
    subscription_id: str

    # --- Local layout ---
    root: Path
    db_path: Path
    spool_dir: Path
    models_dir: Path
    log_dir: Path

    # --- GPU assignment ---
    vlm_gpu: int
    llm_gpu: int

    # --- VLM ---
    vlm_model_id: str
    vlm_architecture: str
    vlm_revision: str | None
    vlm_profile: str
    vlm_slo_ms: int
    vlm_max_new_tokens: int

    # --- LLM ---
    llm_model_path: str
    llm_requested_model: str
    llm_context_size: int
    llm_max_output_tokens: int
    llm_gpu_layers: int
    llm_binary: str

    # --- Pipeline behaviour ---
    window_minutes: int
    max_attempts: int
    session_end_grace_sec: int
    spool_retention_sec: int
    health_port: int
    dry_run: bool

    # Populated at runtime once the GPUs are probed.
    gpu_uuids: dict[int, str] = field(default_factory=dict)

    @property
    def demotion_order(self) -> tuple[str, ...]:
        """Profiles at or below the configured one, for automatic demotion."""
        try:
            start = PROFILE_ORDER.index(self.vlm_profile)
        except ValueError:
            start = 0
        return PROFILE_ORDER[start:]


def load_settings() -> Settings:
    root = Path(os.environ.get("WORKER_ROOT", "/home/suzukilab/study-timelapse-worker"))
    return Settings(
        project_id=_env("GCP_PROJECT_ID"),
        bucket_name=_env("GCS_BUCKET_NAME"),
        subscription_id=_env("PUBSUB_SUBSCRIPTION_ID", "study-timelapse-chunks-sub"),
        root=root,
        db_path=Path(os.environ.get("WORKER_DB_PATH", root / "state" / "pipeline.db")),
        spool_dir=Path(os.environ.get("WORKER_SPOOL_DIR", root / "spool")),
        models_dir=Path(os.environ.get("WORKER_MODELS_DIR", root / "models")),
        log_dir=Path(os.environ.get("WORKER_LOG_DIR", root / "logs")),
        vlm_gpu=_env_int("VLM_GPU", 0),
        llm_gpu=_env_int("LLM_GPU", 1),
        vlm_model_id=os.environ.get(
            "VLM_MODEL_ID", "meta-llama/Llama-3.2-11B-Vision-Instruct"
        ),
        # auto | gemma3 | mllama. "auto" infers from the model id.
        vlm_architecture=os.environ.get("VLM_ARCHITECTURE", "auto"),
        vlm_revision=os.environ.get("VLM_REVISION") or None,
        vlm_profile=os.environ.get("VLM_PROFILE", "original_8"),
        vlm_slo_ms=_env_int("VLM_SLO_MS", 25_000),
        vlm_max_new_tokens=_env_int("VLM_MAX_NEW_TOKENS", 512),
        llm_model_path=os.environ.get("LLM_MODEL_PATH", ""),
        llm_requested_model=os.environ.get(
            "LLM_REQUESTED_MODEL", "Meta-Llama-3-70B-Instruct-Q2_K"
        ),
        llm_context_size=_env_int("LLM_CONTEXT_SIZE", 8192),
        llm_max_output_tokens=_env_int("LLM_MAX_OUTPUT_TOKENS", 1200),
        llm_gpu_layers=_env_int("LLM_GPU_LAYERS", 20),
        llm_binary=os.environ.get("LLM_BINARY", "llama-cli"),
        window_minutes=_env_int("WINDOW_MINUTES", 30),
        max_attempts=_env_int("MAX_ATTEMPTS", 5),
        session_end_grace_sec=_env_int("SESSION_END_GRACE_SEC", 120),
        spool_retention_sec=_env_int("SPOOL_RETENTION_SEC", 24 * 3600),
        health_port=_env_int("HEALTH_PORT", 8799),
        dry_run=_env_bool("WORKER_DRY_RUN", False),
    )
