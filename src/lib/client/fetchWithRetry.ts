"use client";

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 800;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class UploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`アップロードが${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした。`);
    this.name = "UploadTimeoutError";
  }
}

export function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Failed to fetch" || error.message === "Load failed";
}

export function friendlyFetchError(error: unknown, fallback: string): string {
  if (error instanceof UploadTimeoutError) {
    return `${error.message}回線が遅い可能性があります。「アップロードを再試行」で再開できます。`;
  }

  if (isLikelyNetworkError(error)) {
    return "通信に失敗しました。ネットワークが不安定な可能性があります。少し待ってからもう一度試してください。";
  }

  return error instanceof Error ? error.message : fallback;
}

/**
 * PUT a blob with a hard timeout.
 *
 * Without an AbortController a stalled upload never settles: the request sits
 * in "Pending", the chunk stays `uploading` forever, and no retry or error
 * ever fires. The timeout converts an invisible hang into a recorded failure
 * the user can act on.
 */
export async function putWithTimeout(
  url: string,
  body: Blob,
  contentType: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UploadTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { retries?: number; delayMs?: number } = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === retries) {
        return response;
      }
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
    }

    await sleep(delayMs * (attempt + 1));
  }

  return fetch(input, init);
}
