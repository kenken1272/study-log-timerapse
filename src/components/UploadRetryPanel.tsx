"use client";

import { RotateCw } from "lucide-react";
import type { StoredChunk } from "@/lib/client/chunkStore";

type UploadRetryPanelProps = {
  failedChunks: StoredChunk[];
  pendingUploadCount: number;
  isRetrying: boolean;
  onRetry: () => void;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * Surfaces stalled and failed chunk uploads with a way to act on them.
 *
 * Previously a failed upload only produced a single transient message, so a
 * user could finish recording believing everything was saved. Each chunk's own
 * error is shown, and nothing is discarded — the video stays in IndexedDB
 * until it uploads.
 */
export function UploadRetryPanel({
  failedChunks,
  pendingUploadCount,
  isRetrying,
  onRetry,
}: UploadRetryPanelProps) {
  if (failedChunks.length === 0 && pendingUploadCount === 0) {
    return null;
  }

  const hasFailures = failedChunks.length > 0;

  return (
    <div
      className={`mt-4 rounded-lg border p-4 ${
        hasFailures ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-800">
            {hasFailures
              ? `アップロードできていないchunkが${failedChunks.length}件あります`
              : `アップロード待ち ${pendingUploadCount}件`}
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            動画はこのブラウザに保存されています。再試行するまで削除されません。
          </p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          <RotateCw size={16} className={isRetrying ? "animate-spin" : undefined} />
          {isRetrying ? "再試行中…" : "アップロードを再試行"}
        </button>
      </div>

      {hasFailures ? (
        <ul className="mt-3 space-y-1 border-t border-amber-200 pt-3">
          {failedChunks.slice(0, 10).map((chunk) => (
            <li key={chunk.id} className="text-xs text-zinc-700">
              <span className="font-medium">
                セグメント {chunk.segmentIndex} / chunk {chunk.chunkIndex}
              </span>
              <span className="text-zinc-500"> ({formatSize(chunk.sizeBytes)})</span>
              {chunk.errorMessage ? (
                <span className="block break-words text-zinc-600">
                  {chunk.errorMessage}
                </span>
              ) : null}
            </li>
          ))}
          {failedChunks.length > 10 ? (
            <li className="text-xs text-zinc-500">
              ほか {failedChunks.length - 10} 件
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
