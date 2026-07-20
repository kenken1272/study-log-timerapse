"""Validated data shapes for everything that crosses a process boundary.

The VLM and LLM both emit free-form text; nothing is persisted or shown in the
UI until it round-trips through these models.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# users/{uid}/sessions/{sessionId}/segments/{segmentIndex}/chunks/{chunkIndex}.webm
CHUNK_OBJECT_RE = re.compile(
    r"^users/([^/]+)/sessions/([^/]+)/segments/(\d+)/chunks/(\d+)\.webm$"
)


class ChunkRef(BaseModel):
    """A parsed chunk object name plus the GCS generation that identifies it."""

    model_config = ConfigDict(frozen=True)

    uid: str
    session_id: str
    segment_index: int
    chunk_index: int
    generation: str
    object_name: str

    @property
    def idempotency_key(self) -> str:
        # Generation is mandatory: the same object name can be re-uploaded, and
        # those are genuinely different chunks that both deserve analysis.
        return f"{self.object_name}#{self.generation}"


def parse_chunk_object(object_name: str, generation: str | int) -> ChunkRef | None:
    """Return a ChunkRef, or None when the object is not an analysable chunk.

    Anything under analysis/ is our own output and must never be re-ingested.
    """
    match = CHUNK_OBJECT_RE.match(object_name)
    if match is None:
        return None

    uid, session_id, segment_index, chunk_index = match.groups()
    # Defensive: the regex already excludes slashes, but an empty uid or a
    # traversal attempt must never reach a filesystem path.
    if not uid or not session_id or ".." in object_name:
        return None

    return ChunkRef(
        uid=uid,
        session_id=session_id,
        segment_index=int(segment_index),
        chunk_index=int(chunk_index),
        generation=str(generation),
        object_name=object_name,
    )


class SampledFrame(BaseModel):
    offset_seconds: float
    width: int
    height: int


class ChunkMetrics(BaseModel):
    """What the VLM is allowed to claim about a 30s chunk.

    Deliberately limited to observable surface behaviour. No face recognition,
    no identity, no emotion inference.
    """

    concentration_score: int = Field(ge=0, le=100)
    concentration_level: Literal["high", "medium", "low", "unknown"]
    presence: Literal["present", "absent", "unclear"]
    primary_activity: Literal[
        "writing", "reading", "typing", "phone", "talking", "idle", "away", "unclear"
    ]
    phone_use: bool
    away_from_desk: bool
    posture_change_count: int = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)
    status_summary: str = Field(min_length=1, max_length=400)
    evidence_offsets_seconds: list[float] = Field(default_factory=list, max_length=16)


class ChunkRuntime(BaseModel):
    model: str
    quantization: str
    compute_dtype: str = "float32"
    # True when a mock model produced this record. Makes a dry-run artefact
    # sitting in GCS impossible to mistake for a real analysis.
    dry_run: bool = False
    download_ms: int = 0
    model_load_ms: int = 0
    decode_ms: int = 0
    frame_extract_ms: int = 0
    vlm_preprocess_ms: int = 0
    vlm_generate_ms: int = 0
    json_validate_ms: int = 0
    upload_ms: int = 0
    total_ms: int = 0
    peak_vram_mib: int = 0


class ChunkAnalysis(BaseModel):
    """Persisted to analysis/chunks/{segmentIndex}/{chunkIndex}.json."""

    schema_version: int = SCHEMA_VERSION
    uid: str
    session_id: str
    segment_index: int
    chunk_index: int
    gcs_generation: str
    source_object: str
    chunk_started_at: str | None = None
    chunk_ended_at: str | None = None
    profile: str
    sampled_frames: list[SampledFrame]
    metrics: ChunkMetrics
    runtime: ChunkRuntime
    created_at: str


class Period(BaseModel):
    start: str
    end: str
    note: str = ""


class Recommendation(BaseModel):
    priority: int = Field(ge=1, le=10)
    title: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=600)
    action: str = Field(min_length=1, max_length=600)


class Concentration(BaseModel):
    average_score: float = Field(ge=0, le=100)
    trend: Literal["improving", "declining", "stable", "fluctuating", "unknown"]
    high_periods: list[Period] = Field(default_factory=list, max_length=20)
    low_periods: list[Period] = Field(default_factory=list, max_length=20)


class AnalysisWindow(BaseModel):
    start: str
    end: str
    chunk_count: int = Field(ge=0)
    missing_chunk_count: int = Field(ge=0)


class DataQuality(BaseModel):
    coverage_ratio: float = Field(ge=0.0, le=1.0)
    warnings: list[str] = Field(default_factory=list, max_length=20)


class LlmRuntime(BaseModel):
    requested_model: str
    used_model: str
    quantization: str
    compute_dtype: str = "float32"
    fallback_used: bool = False
    fallback_reason: str | None = None
    context_size: int
    prompt_tokens: int = 0
    output_tokens: int = 0
    model_load_ms: int = 0
    inference_ms: int = 0
    peak_vram_mib: int = 0


class AggregateAnalysis(BaseModel):
    """Persisted to analysis/windows/{startIso}.json and analysis.json."""

    schema_version: int = SCHEMA_VERSION
    session_id: str
    analysis_type: Literal["window", "final"]
    window: AnalysisWindow
    summary: str = Field(min_length=1, max_length=4000)
    concentration: Concentration
    observed_patterns: list[str] = Field(default_factory=list, max_length=20)
    bottlenecks: list[str] = Field(default_factory=list, max_length=20)
    recommendations: list[Recommendation] = Field(default_factory=list, max_length=10)
    data_quality: DataQuality
    runtime: LlmRuntime
    generated_at: str


class AnalysisStatus(BaseModel):
    """Persisted to analysis/status.json — what the UI polls."""

    schema_version: int = SCHEMA_VERSION
    session_id: str
    state: Literal["queued", "processing", "partial", "ready", "failed"]
    chunks_total: int = 0
    chunks_completed: int = 0
    chunks_failed: int = 0
    windows_completed: int = 0
    current_profile: str | None = None
    demoted: bool = False
    message: str | None = None
    updated_at: str


def utc_now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def extract_json_text(text: str) -> str:
    """Pull a JSON object out of a model response that may be fenced or prefixed."""
    trimmed = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", trimmed)
    if fenced and fenced.group(1):
        return fenced.group(1).strip()

    # A top-level array must be extracted as an array, not by slicing between
    # the first "{" and last "}" — that would produce "{a},{b}", which is not
    # valid JSON and would look like a model failure rather than a shape issue.
    first_bracket = trimmed.find("[")
    first_brace = trimmed.find("{")
    if first_bracket >= 0 and (first_brace < 0 or first_bracket < first_brace):
        last_bracket = trimmed.rfind("]")
        if last_bracket > first_bracket:
            return trimmed[first_bracket : last_bracket + 1]

    if first_brace >= 0:
        last = trimmed.rfind("}")
        if last > first_brace:
            return trimmed[first_brace : last + 1]

    return trimmed


def repair_json_text(text: str) -> str:
    """One conservative repair pass for the most common model JSON defects.

    Only structural noise is fixed — never invented values. If this does not
    produce valid JSON the chunk goes to RETRY_WAIT rather than being accepted.
    """
    candidate = extract_json_text(text)
    # Trailing commas before a closing brace/bracket.
    candidate = re.sub(r",(\s*[}\]])", r"\1", candidate)
    # Python-style literals.
    candidate = re.sub(r"\bTrue\b", "true", candidate)
    candidate = re.sub(r"\bFalse\b", "false", candidate)
    candidate = re.sub(r"\bNone\b", "null", candidate)
    # Unterminated object: close whatever is still open.
    opens = candidate.count("{") - candidate.count("}")
    if opens > 0:
        candidate += "}" * opens
    return candidate


def _unwrap(value):
    """Accept a single-object array as well as a bare object.

    Gemma 3 sometimes wraps its answer in a list — one entry per input image,
    or just a stray pair of brackets. Taking the first object is safe; a
    multi-entry list is not, because picking one would silently discard the
    model's other answers.
    """
    if isinstance(value, list):
        if len(value) == 1 and isinstance(value[0], dict):
            return value[0]
        raise ValueError(
            f"expected a single JSON object, got a list of {len(value)}"
        )
    return value


def _decode_first(candidate: str):
    """Decode the first complete JSON value, tolerating trailing content.

    A model that emits a complete answer and then keeps talking — repeating the
    object, or appending commentary — has still answered. Taking the first
    complete value is safe; unlike a multi-entry array, the trailing text is not
    a second distinct answer being discarded. The discard is logged.
    """
    decoder = json.JSONDecoder()
    stripped = candidate.lstrip()
    value, end = decoder.raw_decode(stripped)
    remainder = stripped[end:].strip()
    if remainder:
        log.warning(
            "discarded %d characters of trailing content after the JSON value",
            len(remainder),
        )
    return value


def parse_model_json(text: str) -> dict:
    """Parse model output, attempting exactly one repair pass on failure."""
    candidate = extract_json_text(text)
    try:
        return _unwrap(json.loads(candidate))
    except json.JSONDecodeError:
        pass

    # "Extra data" — a complete value followed by more output — is recoverable.
    try:
        return _unwrap(_decode_first(candidate))
    except (json.JSONDecodeError, ValueError):
        pass

    return _unwrap(json.loads(repair_json_text(text)))
