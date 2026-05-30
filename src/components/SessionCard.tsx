import Link from "next/link";
import { SessionThumbnail } from "@/components/SessionThumbnail";
import type { JsonStudySession } from "@/lib/sessions/types";
import { formatDuration, formatShortDate } from "@/lib/time/format";

type SessionCardProps = {
  session: JsonStudySession;
};

export function SessionCard({ session }: SessionCardProps) {
  return (
    <article className="overflow-hidden rounded-lg border border-zinc-200 bg-white transition hover:border-zinc-400">
      <Link href={`/sessions/${session.id}`} className="block">
        {session.type === "recorded" ? <SessionThumbnail session={session} /> : null}
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-zinc-500">{formatShortDate(session.startedAt)}</p>
              <h3 className="mt-1 font-semibold text-zinc-950">
                {session.studyContent ?? "録画セッション"}
              </h3>
            </div>
            <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-700">
              {session.type === "offline" ? "オフライン入力" : session.status}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div>
              <p className="text-zinc-500">実勉強</p>
              <p className="font-medium">{formatDuration(session.actualStudySec)}</p>
            </div>
            <div>
              <p className="text-zinc-500">休憩</p>
              <p className="font-medium">{formatDuration(session.totalBreakSec)}</p>
            </div>
            <div>
              <p className="text-zinc-500">品質</p>
              <p className="font-medium">{session.quality ?? "-"}</p>
            </div>
          </div>
        </div>
      </Link>
    </article>
  );
}
