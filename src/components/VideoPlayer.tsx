"use client";

import { useEffect, useState } from "react";

type VideoPlayerProps = {
  sessionId: string;
  isReady: boolean;
};

export function VideoPlayer({ sessionId, isReady }: VideoPlayerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    let cancelled = false;
    async function loadUrl() {
      const response = await fetch(`/api/sessions/${sessionId}/video-url`);
      if (!response.ok) {
        setError("動画URLを取得できませんでした。");
        return;
      }
      const body = (await response.json()) as { url: string };
      if (!cancelled) {
        setUrl(body.url);
      }
    }

    void loadUrl();
    return () => {
      cancelled = true;
    };
  }, [isReady, sessionId]);

  if (!isReady) {
    return <p className="text-sm text-zinc-500">タイムラプス動画はまだ準備中です。</p>;
  }

  if (error) {
    return <p className="text-sm text-red-700">{error}</p>;
  }

  if (!url) {
    return <p className="text-sm text-zinc-500">動画URLを取得中...</p>;
  }

  return <video src={url} controls className="aspect-video w-full rounded-lg bg-black" />;
}
