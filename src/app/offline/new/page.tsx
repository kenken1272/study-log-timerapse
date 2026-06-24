"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save } from "lucide-react";
import { AuthGate } from "@/components/auth/AuthGate";
import { QualitySelector } from "@/components/QualitySelector";
import { StudyMinutesControl } from "@/components/StudyMinutesControl";
import { useAuth } from "@/hooks/use-auth";
import type { JsonStudySession, StudyQuality } from "@/lib/sessions/types";
import { dateInputValue } from "@/lib/time/format";

export default function OfflineSessionPage() {
  const router = useRouter();
  const { authFetch, isLoading: isAuthLoading, user } = useAuth();
  const [studyDate, setStudyDate] = useState(dateInputValue(new Date()));
  const [studyMinutes, setStudyMinutes] = useState(60);
  const [breakMinutes, setBreakMinutes] = useState(0);
  const [studyContent, setStudyContent] = useState("");
  const [quality, setQuality] = useState<StudyQuality>(3);
  const [reflectionNote, setReflectionNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage(null);
    try {
      const response = await authFetch("/api/offline-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studyDate,
          studyMinutes,
          breakMinutes,
          studyContent,
          quality,
          reflectionNote,
        }),
      });
      if (!response.ok) {
        throw new Error("保存に失敗しました。");
      }
      const body = (await response.json()) as { session: JsonStudySession };
      router.push(`/sessions/${body.session.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  if (isAuthLoading) {
    return (
      <main className="min-h-screen bg-zinc-50 text-zinc-950">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            認証確認中...
          </div>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-zinc-50 text-zinc-950">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
          >
            <ArrowLeft size={16} />
            ダッシュボードへ
          </Link>
          <div className="mt-8">
            <AuthGate />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
        >
          <ArrowLeft size={16} />
          ダッシュボードへ
        </Link>
        <header className="my-8">
          <h1 className="text-3xl font-semibold tracking-normal">オフライン勉強時間入力</h1>
        </header>
        <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">勉強日</span>
            <input
              type="date"
              value={studyDate}
              onChange={(event) => setStudyDate(event.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <StudyMinutesControl
              key={studyMinutes}
              label="勉強時間（分）"
              value={studyMinutes}
              onChange={setStudyMinutes}
            />
            <label className="block">
              <span className="text-sm font-medium text-zinc-700">休憩時間（分）</span>
              <input
                type="number"
                min={0}
                value={breakMinutes}
                onChange={(event) => setBreakMinutes(Number(event.target.value))}
                className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">勉強内容</span>
            <input
              value={studyContent}
              onChange={(event) => setStudyContent(event.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
          <div>
            <p className="mb-2 text-sm font-medium text-zinc-700">勉強クオリティ</p>
            <QualitySelector value={quality} onChange={setQuality} />
          </div>
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">メモ</span>
            <textarea
              value={reflectionNote}
              onChange={(event) => setReflectionNote(event.target.value)}
              className="mt-2 min-h-28 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
          <button
            type="submit"
            disabled={isSaving || studyContent.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            <Save size={18} />
            保存
          </button>
          {message ? <p className="text-sm text-red-700">{message}</p> : null}
        </form>
      </div>
    </main>
  );
}
