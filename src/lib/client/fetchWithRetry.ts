"use client";

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 800;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Failed to fetch" || error.message === "Load failed";
}

export function friendlyFetchError(error: unknown, fallback: string): string {
  if (isLikelyNetworkError(error)) {
    return "通信に失敗しました。ネットワークが不安定な可能性があります。少し待ってからもう一度試してください。";
  }

  return error instanceof Error ? error.message : fallback;
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
