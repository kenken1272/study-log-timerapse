import type { AnalysisResult, FocusLabel } from "@/lib/sessions/types";

const focusLabels: FocusLabel[] = ["かなり低い", "低い", "普通", "高い", "とても高い"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}.`);
  }

  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }

  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }

  return value;
}

function focusLabelValue(value: unknown): FocusLabel {
  if (focusLabels.includes(value as FocusLabel)) {
    return value as FocusLabel;
  }

  throw new Error("focusLabel is invalid.");
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 10);
}

export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function parseAnalysisResult(text: string): AnalysisResult {
  const parsed = JSON.parse(extractJsonText(text)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Analysis response must be a JSON object.");
  }

  const studyDetected = parsed.studyDetected;
  if (typeof studyDetected !== "boolean") {
    throw new Error("studyDetected must be boolean.");
  }

  return {
    focusScore: numberInRange(parsed.focusScore, 0, 100, "focusScore"),
    focusLabel: focusLabelValue(parsed.focusLabel),
    studyDetected,
    estimatedAbsenceMinutes: nonNegativeNumber(
      parsed.estimatedAbsenceMinutes,
      "estimatedAbsenceMinutes",
    ),
    estimatedPhoneUseMinutes: nonNegativeNumber(
      parsed.estimatedPhoneUseMinutes,
      "estimatedPhoneUseMinutes",
    ),
    estimatedWritingReadingMinutes: nonNegativeNumber(
      parsed.estimatedWritingReadingMinutes,
      "estimatedWritingReadingMinutes",
    ),
    summary: stringValue(parsed.summary, "summary"),
    evidence: stringArray(parsed.evidence, "evidence"),
    uncertainty: stringValue(parsed.uncertainty, "uncertainty"),
    advice: stringValue(parsed.advice, "advice"),
  };
}
