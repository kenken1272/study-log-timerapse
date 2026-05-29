"use client";

import { useEffect, useState } from "react";
import { PlayCircle } from "lucide-react";
import type { JsonStudySession } from "@/lib/sessions/types";

type SessionThumbnailProps = {
  session: JsonStudySession;
};

export function SessionThumbnail({ session }: SessionThumbnailProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    if (session.status !== "ready" || !session.thumbnailPath) {
      return;
    }

    let cancelled = false;
    fetch(`/api/sessions/${session.id}/thumbnail-url`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Thumbnail is not ready.");
        }

        return response.json() as Promise<{ url: string }>;
      })
      .then((body) => {
        if (!cancelled) {
          setThumbnailUrl(body.url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbnailUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session.id, session.status, session.thumbnailPath]);

  const label = session.status === "ready" ? "再生" : "詳細";
  const imageUrl = session.status === "ready" ? thumbnailUrl : null;

  return (
    <div className="relative border-b border-zinc-200 bg-zinc-50">
      <div
        aria-label="タイムラプス動画のサムネイル"
        className="aspect-video w-full bg-cover bg-center"
        style={{
          backgroundImage: `url(${imageUrl ?? "/timelapse-preview.svg"})`,
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/10">
        <div className="inline-flex items-center gap-2 rounded-full bg-white/90 px-3 py-2 text-sm font-medium text-zinc-950 shadow-sm">
          <PlayCircle size={20} />
          {label}
        </div>
      </div>
    </div>
  );
}
