"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, RotateCw, Save, Trash2, X } from "lucide-react";
import { QualitySelector } from "@/components/QualitySelector";
import { VideoPlayer } from "@/components/VideoPlayer";
import type { JsonStudySession, StudyQuality } from "@/lib/sessions/types";
import { formatDuration, formatShortDate } from "@/lib/time/format";

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<JsonStudySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editStudyContent, setEditStudyContent] = useState("");
  const [editQuality, setEditQuality] = useState<StudyQuality>(3);
  const [editReflectionNote, setEditReflectionNote] = useState("");

  const loadSession = useCallback(async () => {
    const response = await fetch(`/api/sessions/${params.id}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("セッションを取得できませんでした。");
    }
    const body = (await response.json()) as { session: JsonStudySession };
    setSession(body.session);
    setEditStudyContent(body.session.studyContent ?? "");
    setEditQuality(body.session.quality ?? 3);
    setEditReflectionNote(body.session.reflectionNote ?? "");
  }, [params.id]);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/sessions/${params.id}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("セッションを取得できませんでした。");
        }

        return response.json() as Promise<{ session: JsonStudySession }>;
      })
      .then((body) => {
        if (!cancelled) {
          setSession(body.session);
          setEditStudyContent(body.session.studyContent ?? "");
          setEditQuality(body.session.quality ?? 3);
          setEditReflectionNote(body.session.reflectionNote ?? "");
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "読み込みに失敗しました。");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function handleProcess() {
    setIsProcessing(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${params.id}/process`, { method: "POST" });
      if (!response.ok) {
        throw new Error("タイムラプス生成に失敗しました。");
      }
      await loadSession();
    } catch (processError) {
      setError(
        processError instanceof Error ? processError.message : "タイムラプス生成に失敗しました。",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSaveEdit() {
    if (!session) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studyContent: editStudyContent,
          quality: editQuality,
          reflectionNote: editReflectionNote,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "更新に失敗しました。");
      }

      const body = (await response.json()) as { session: JsonStudySession };
      setSession(body.session);
      setIsEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "更新に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!session) {
      return;
    }
    const confirmed = window.confirm(
      "このセッションを削除します。録画chunk、タイムラプス動画、サムネイルも削除されます。",
    );
    if (!confirmed) {
      return;
    }

    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "削除に失敗しました。");
      }

      router.push("/");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "削除に失敗しました。");
      setIsDeleting(false);
    }
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950">
        <div className="mx-auto max-w-4xl rounded-lg border border-zinc-200 bg-white p-6">
          {error ?? "読み込み中..."}
        </div>
      </main>
    );
  }

  const metrics = [
    ["開始", formatShortDate(session.startedAt)],
    ["終了", session.endedAt ? formatShortDate(session.endedAt) : "-"],
    ["目標", session.targetStudySec ? formatDuration(session.targetStudySec) : "-"],
    ["全体時間", session.totalElapsedSec ? formatDuration(session.totalElapsedSec) : "-"],
    ["休憩時間", formatDuration(session.totalBreakSec)],
    ["実勉強時間", formatDuration(session.actualStudySec)],
    [
      "達成率",
      session.achievementRate === null ? "-" : `${Math.round(session.achievementRate)}%`,
    ],
    ["クオリティ", session.quality ? `${session.quality} / 5` : "-"],
  ];

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-6">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
        >
          <ArrowLeft size={16} />
          ダッシュボードへ
        </Link>
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm text-zinc-500">
              {session.type === "offline" ? "オフライン入力" : "録画セッション"}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">
              {session.studyContent ?? "勉強セッション"}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-fit rounded-full bg-zinc-900 px-3 py-1 text-sm text-white">
              {session.status}
            </span>
            <button
              type="button"
              onClick={() => setIsEditing((current) => !current)}
              className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 hover:bg-zinc-50"
            >
              {isEditing ? <X size={16} /> : <Pencil size={16} />}
              {isEditing ? "閉じる" : "編集"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={16} />
              削除
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <section className="grid gap-3 md:grid-cols-4">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-zinc-200 bg-white p-4">
              <p className="text-sm text-zinc-500">{label}</p>
              <p className="mt-2 font-semibold">{value}</p>
            </div>
          ))}
        </section>

        {isEditing ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-xl font-semibold">セッション編集</h2>
            <div className="mt-4 space-y-5">
              <label className="block">
                <span className="text-sm font-medium text-zinc-700">勉強内容</span>
                <input
                  value={editStudyContent}
                  onChange={(event) => setEditStudyContent(event.target.value)}
                  className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
                />
              </label>
              <div>
                <p className="mb-2 text-sm font-medium text-zinc-700">勉強クオリティ</p>
                <QualitySelector value={editQuality} onChange={setEditQuality} />
              </div>
              <label className="block">
                <span className="text-sm font-medium text-zinc-700">メモ</span>
                <textarea
                  value={editReflectionNote}
                  onChange={(event) => setEditReflectionNote(event.target.value)}
                  className="mt-2 min-h-28 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
                />
              </label>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                <Save size={18} />
                保存
              </button>
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-xl font-semibold">タイムラプス動画</h2>
          <div className="mt-4">
            {session.type === "recorded" ? (
              <VideoPlayer sessionId={session.id} isReady={session.status === "ready"} />
            ) : (
              <p className="text-sm text-zinc-500">オフライン入力には動画がありません。</p>
            )}
          </div>
          {session.status === "uploaded" || session.status === "failed" ? (
            <button
              type="button"
              onClick={handleProcess}
              disabled={isProcessing}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
            >
              <RotateCw size={18} />
              タイムラプス生成
            </button>
          ) : null}
          {session.errorMessage ? (
            <p className="mt-3 text-sm text-red-700">{session.errorMessage}</p>
          ) : null}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-xl font-semibold">メモ</h2>
            <p className="mt-3 whitespace-pre-wrap text-zinc-700">
              {session.reflectionNote ?? "-"}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-xl font-semibold">休憩履歴</h2>
            <div className="mt-3 space-y-2">
              {session.breakLogs.length > 0 ? (
                session.breakLogs.map((breakLog, index) => (
                  <div key={`${breakLog.startedAt}-${index}`} className="text-sm text-zinc-700">
                    {formatShortDate(breakLog.startedAt)} /{" "}
                    {breakLog.durationSec === null
                      ? "進行中"
                      : formatDuration(breakLog.durationSec)}
                  </div>
                ))
              ) : (
                <p className="text-sm text-zinc-500">休憩履歴はありません。</p>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
