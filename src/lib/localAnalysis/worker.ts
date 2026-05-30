import { extractJsonText as extractJsonTextRaw } from "@/lib/vertex/types";
import { isRecord } from "@/lib/validation";
import type { AnalysisResult, FocusLabel } from "@/lib/sessions/types";

const focusLabels: FocusLabel[] = ["かなり低い", "低い", "普通", "高い", "とても高い"];
const MAX_LOCAL_ANALYSIS_TIMEOUT_MS = 5 * 60 * 60 * 1000;

export const LOCAL_ANALYSIS_PROMPT = `あなたは勉強記録タイムラプス動画を分析するアシスタントです。

この動画は、ユーザーが勉強している様子をタイムラプス化したものです。
動画から見える行動だけを根拠に、勉強集中度を0〜100で評価してください。

評価基準:
- 机に向かっている時間
- 書く、読む、PC作業などの勉強行動
- 離席時間
- スマホ操作らしき行動
- 寝ている、ぼーっとしている、画面外にいる時間
- 休憩らしき時間

重要な注意:
- 本人の内面、感情、性格、健康状態を断定しない
- 顔、年齢、性別、個人属性を推測しない
- 映像から確認できる行動だけを根拠にする
- 不確実な場合は不確実と書く
- 医療的、心理的な診断をしない
- 必ずJSONだけで返す
- Markdownや説明文をJSONの外に出さない

出力形式:
{
  "focusScore": number,
  "focusLabel": "かなり低い" | "低い" | "普通" | "高い" | "とても高い",
  "studyDetected": boolean,
  "estimatedAbsenceMinutes": number,
  "estimatedPhoneUseMinutes": number,
  "estimatedWritingReadingMinutes": number,
  "summary": string,
  "evidence": string[],
  "uncertainty": string,
  "advice": string
}`;

export function extractJsonText(input: string): string {
  return extractJsonTextRaw(input);
}

export function parseJsonFromUnknownResponse(input: unknown): unknown {
  if (typeof input === "string") {
    const text = extractJsonText(input);
    return JSON.parse(text) as unknown;
  }

  return input;
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

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
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

  const filtered = value.filter((item): item is string => typeof item === "string");
  if (filtered.length !== value.length) {
    throw new Error(`${field} must be an array of strings.`);
  }

  return filtered;
}

export function validateStudyAnalysisResult(input: unknown): AnalysisResult {
  if (!isRecord(input)) {
    throw new Error("Analysis result must be a JSON object.");
  }

  return {
    focusScore: numberInRange(input.focusScore, 0, 100, "focusScore"),
    focusLabel: focusLabelValue(input.focusLabel),
    studyDetected: booleanValue(input.studyDetected, "studyDetected"),
    estimatedAbsenceMinutes: nonNegativeNumber(
      input.estimatedAbsenceMinutes,
      "estimatedAbsenceMinutes",
    ),
    estimatedPhoneUseMinutes: nonNegativeNumber(
      input.estimatedPhoneUseMinutes,
      "estimatedPhoneUseMinutes",
    ),
    estimatedWritingReadingMinutes: nonNegativeNumber(
      input.estimatedWritingReadingMinutes,
      "estimatedWritingReadingMinutes",
    ),
    summary: stringValue(input.summary, "summary"),
    evidence: stringArray(input.evidence, "evidence"),
    uncertainty: stringValue(input.uncertainty, "uncertainty"),
    advice: stringValue(input.advice, "advice"),
  };
}

export function normalizeGpuWorkerResponse(input: unknown): { model: string; result: AnalysisResult } {
  const parsed = parseJsonFromUnknownResponse(input);
  if (!isRecord(parsed)) {
    throw new Error("GPU worker response must be a JSON object.");
  }

  if ("ok" in parsed && parsed.ok === false) {
    const message = typeof parsed.error === "string" ? parsed.error : "GPU worker returned error.";
    throw new Error(message);
  }

  const model = typeof parsed.model === "string" ? parsed.model : "Qwen/Qwen2.5-VL-7B-Instruct";
  const resultSource = "result" in parsed ? parsed.result : parsed;

  return {
    model,
    result: validateStudyAnalysisResult(resultSource),
  };
}

export async function requestLocalVideoAnalysis(params: {
  sessionId: string;
  videoUrl: string;
  prompt: string;
  fps: number;
  maxPixels: number;
  segmentSeconds: number;
  maxSegments: number;
  timeoutMs?: number;
}): Promise<{ model: string; result: AnalysisResult }> {
  const workerUrl = process.env.GPU_WORKER_URL;
  const workerToken = process.env.GPU_WORKER_TOKEN;
  if (!workerUrl || !workerToken) {
    throw new Error(
      "ローカル分析workerが未設定です。GPU_WORKER_URL と GPU_WORKER_TOKEN を .env.local またはCloud Run環境変数に設定してください。",
    );
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(
    MAX_LOCAL_ANALYSIS_TIMEOUT_MS,
    Math.max(1_000, params.timeoutMs ?? MAX_LOCAL_ANALYSIS_TIMEOUT_MS),
  );
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(`${workerUrl.replace(/\/$/, "")}/vlm-video`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          session_id: params.sessionId,
          video_url: params.videoUrl,
          prompt: params.prompt,
          fps: params.fps,
          max_pixels: params.maxPixels,
          segment_seconds: params.segmentSeconds,
          max_segments: params.maxSegments,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("ローカル分析workerへのリクエストが5時間以内に完了しませんでした。");
      }
      const message = error instanceof Error ? error.message : "Unknown fetch error.";
      throw new Error(
        `ローカル分析workerへ接続できませんでした。GPU_WORKER_URLのworkerが起動中で、このアプリから到達できるか確認してください。詳細: ${message}`,
      );
    }

    const rawBody = await response.text();
    if (!response.ok) {
      const bodyMessage = extractWorkerErrorMessage(rawBody);
      throw new Error(
        `ローカル分析workerがHTTP ${response.status}を返しました。${bodyMessage}`,
      );
    }

    const parsed = rawBody ? parseJsonFromUnknownResponse(rawBody) : null;
    return normalizeGpuWorkerResponse(parsed);
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractWorkerErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "レスポンス本文は空でした。";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      const candidates = [parsed.error, parsed.message, parsed.detail];
      const text = candidates.find((value): value is string => typeof value === "string");
      if (text) {
        return text.slice(0, 2000);
      }
    }
  } catch {
    return trimmed.slice(0, 2000);
  }

  return trimmed.slice(0, 2000);
}
