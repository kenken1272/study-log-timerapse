import type { StudyQuality, TimelapseSpeed } from "@/lib/sessions/types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    throw new Error("Invalid JSON body.");
  }

  return body;
}

export function requiredString(
  value: unknown,
  fieldName: string,
  maxLength = 5000,
): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmed.slice(0, maxLength);
}

export function optionalString(value: unknown, maxLength = 5000): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("Value must be a string.");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

export function positiveNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }

  return value;
}

export function nonNegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }

  return value;
}

export function qualityValue(value: unknown): StudyQuality {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) {
    return value;
  }

  throw new Error("quality must be between 1 and 5.");
}

export function speedValue(value: unknown): TimelapseSpeed {
  if (value === 30 || value === 60 || value === 120) {
    return value;
  }

  throw new Error("speed must be 30, 60, or 120.");
}

export function integerValue(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  return value as number;
}
