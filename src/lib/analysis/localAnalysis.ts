import { downloadJsonFromObject } from "@/lib/gcp/storage";

export type LocalAnalysisState =
  | "queued"
  | "processing"
  | "partial"
  | "ready"
  | "failed";

export type LocalAnalysisStatus = {
  schema_version: number;
  session_id: string;
  state: LocalAnalysisState;
  chunks_total: number;
  chunks_completed: number;
  chunks_failed: number;
  windows_completed: number;
  current_profile: string | null;
  demoted: boolean;
  message: string | null;
  updated_at: string;
};

export type LocalAnalysisPeriod = {
  start: string;
  end: string;
  note: string;
};

export type LocalAnalysisRecommendation = {
  priority: number;
  title: string;
  reason: string;
  action: string;
};

export type LocalAnalysisReport = {
  schema_version: number;
  session_id: string;
  analysis_type: "window" | "final";
  window: {
    start: string;
    end: string;
    chunk_count: number;
    missing_chunk_count: number;
  };
  summary: string;
  concentration: {
    average_score: number;
    trend: "improving" | "declining" | "stable" | "fluctuating" | "unknown";
    high_periods: LocalAnalysisPeriod[];
    low_periods: LocalAnalysisPeriod[];
  };
  observed_patterns: string[];
  bottlenecks: string[];
  recommendations: LocalAnalysisRecommendation[];
  data_quality: {
    coverage_ratio: number;
    warnings: string[];
  };
  runtime: {
    requested_model: string;
    used_model: string;
    quantization: string;
    fallback_used: boolean;
    fallback_reason: string | null;
    context_size: number;
    inference_ms: number;
    peak_vram_mib: number;
  };
  generated_at: string;
};

/**
 * Object paths for the Ubuntu worker's output.
 *
 * These are built here from a verified uid, never from client input, and the
 * uid segment is never omitted.
 */
export function localAnalysisStatusPath(uid: string, sessionId: string): string {
  return `users/${uid}/sessions/${sessionId}/analysis/status.json`;
}

export function localAnalysisReportPath(uid: string, sessionId: string): string {
  return `users/${uid}/sessions/${sessionId}/analysis.json`;
}

const VALID_STATES: LocalAnalysisState[] = [
  "queued",
  "processing",
  "partial",
  "ready",
  "failed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string").slice(0, limit);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toPeriods(value: unknown): LocalAnalysisPeriod[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .slice(0, 20)
    .map((item) => ({
      start: typeof item.start === "string" ? item.start : "",
      end: typeof item.end === "string" ? item.end : "",
      note: typeof item.note === "string" ? item.note : "",
    }));
}

function toRecommendations(value: unknown): LocalAnalysisRecommendation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .slice(0, 10)
    .map((item, index) => ({
      priority: toNumber(item.priority, index + 1),
      title: typeof item.title === "string" ? item.title : "",
      reason: typeof item.reason === "string" ? item.reason : "",
      action: typeof item.action === "string" ? item.action : "",
    }))
    .filter((item) => item.title.length > 0);
}

/**
 * Re-validate the worker's output before it reaches the browser.
 *
 * The worker already validates against a Pydantic schema, but this file is
 * written by a separate host: treating it as untrusted here means a malformed
 * or truncated upload degrades the panel instead of breaking the page.
 */
export function normalizeStatus(value: unknown): LocalAnalysisStatus | null {
  if (!isRecord(value)) {
    return null;
  }

  const state = value.state;
  if (typeof state !== "string" || !VALID_STATES.includes(state as LocalAnalysisState)) {
    return null;
  }

  return {
    schema_version: toNumber(value.schema_version, 1),
    session_id: typeof value.session_id === "string" ? value.session_id : "",
    state: state as LocalAnalysisState,
    chunks_total: toNumber(value.chunks_total, 0),
    chunks_completed: toNumber(value.chunks_completed, 0),
    chunks_failed: toNumber(value.chunks_failed, 0),
    windows_completed: toNumber(value.windows_completed, 0),
    current_profile:
      typeof value.current_profile === "string" ? value.current_profile : null,
    demoted: value.demoted === true,
    message: typeof value.message === "string" ? value.message : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

export function normalizeReport(value: unknown): LocalAnalysisReport | null {
  if (!isRecord(value)) {
    return null;
  }

  const summary = typeof value.summary === "string" ? value.summary : "";
  if (!summary) {
    return null;
  }

  const window = isRecord(value.window) ? value.window : {};
  const concentration = isRecord(value.concentration) ? value.concentration : {};
  const dataQuality = isRecord(value.data_quality) ? value.data_quality : {};
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  const trend = concentration.trend;

  return {
    schema_version: toNumber(value.schema_version, 1),
    session_id: typeof value.session_id === "string" ? value.session_id : "",
    analysis_type: value.analysis_type === "window" ? "window" : "final",
    window: {
      start: typeof window.start === "string" ? window.start : "",
      end: typeof window.end === "string" ? window.end : "",
      chunk_count: toNumber(window.chunk_count, 0),
      missing_chunk_count: toNumber(window.missing_chunk_count, 0),
    },
    summary,
    concentration: {
      average_score: toNumber(concentration.average_score, 0),
      trend:
        trend === "improving" ||
        trend === "declining" ||
        trend === "stable" ||
        trend === "fluctuating"
          ? trend
          : "unknown",
      high_periods: toPeriods(concentration.high_periods),
      low_periods: toPeriods(concentration.low_periods),
    },
    observed_patterns: toStringArray(value.observed_patterns, 20),
    bottlenecks: toStringArray(value.bottlenecks, 20),
    recommendations: toRecommendations(value.recommendations),
    data_quality: {
      coverage_ratio: toNumber(dataQuality.coverage_ratio, 1),
      warnings: toStringArray(dataQuality.warnings, 20),
    },
    runtime: {
      requested_model:
        typeof runtime.requested_model === "string" ? runtime.requested_model : "",
      used_model: typeof runtime.used_model === "string" ? runtime.used_model : "",
      quantization: typeof runtime.quantization === "string" ? runtime.quantization : "",
      fallback_used: runtime.fallback_used === true,
      fallback_reason:
        typeof runtime.fallback_reason === "string" ? runtime.fallback_reason : null,
      context_size: toNumber(runtime.context_size, 0),
      inference_ms: toNumber(runtime.inference_ms, 0),
      peak_vram_mib: toNumber(runtime.peak_vram_mib, 0),
    },
    generated_at: typeof value.generated_at === "string" ? value.generated_at : "",
  };
}

export async function readLocalAnalysis(
  uid: string,
  sessionId: string,
): Promise<{ status: LocalAnalysisStatus | null; report: LocalAnalysisReport | null }> {
  const [rawStatus, rawReport] = await Promise.all([
    downloadJsonFromObject<unknown>(localAnalysisStatusPath(uid, sessionId)),
    downloadJsonFromObject<unknown>(localAnalysisReportPath(uid, sessionId)),
  ]);

  return {
    status: normalizeStatus(rawStatus),
    report: normalizeReport(rawReport),
  };
}
