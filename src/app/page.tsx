"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Clock, Plus } from "lucide-react";
import { SessionCard } from "@/components/SessionCard";
import { StatsCards } from "@/components/StatsCards";
import { WeeklyGoalCard } from "@/components/WeeklyGoalCard";
import type { DashboardStats, JsonStudySession } from "@/lib/sessions/types";

type DashboardState = {
  stats: DashboardStats | null;
  sessions: JsonStudySession[];
  error: string | null;
};

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState>({
    stats: null,
    sessions: [],
    error: null,
  });

  useEffect(() => {
    async function loadDashboard() {
      try {
        const [statsResponse, sessionsResponse] = await Promise.all([
          fetch("/api/sessions/stats", { cache: "no-store" }),
          fetch("/api/sessions", { cache: "no-store" }),
        ]);
        if (!statsResponse.ok || !sessionsResponse.ok) {
          throw new Error("ダッシュボードを読み込めませんでした。");
        }
        const statsBody = (await statsResponse.json()) as { stats: DashboardStats };
        const sessionsBody = (await sessionsResponse.json()) as {
          sessions: JsonStudySession[];
        };
        setState({
          stats: statsBody.stats,
          sessions: sessionsBody.sessions,
          error: null,
        });
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "読み込みに失敗しました。",
        }));
      }
    }

    void loadDashboard();
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-700">Study Timelapse</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">勉強ログ</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/sessions/new"
              className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800"
            >
              <Plus size={18} />
              新規セッション
            </Link>
            <Link
              href="/offline/new"
              className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-zinc-800 hover:bg-zinc-50"
            >
              <Clock size={18} />
              オフライン入力
            </Link>
          </div>
        </header>

        {state.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {state.error}
          </div>
        ) : null}

        {state.stats ? (
          <>
            <StatsCards stats={state.stats} />
            <WeeklyGoalCard stats={state.stats} />
          </>
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            読み込み中...
          </div>
        )}

        <section>
          <div className="mb-4 flex items-center gap-2">
            <BookOpen size={20} />
            <h2 className="text-xl font-semibold">最近の勉強セッション</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {state.sessions.length > 0 ? (
              state.sessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))
            ) : (
              <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
                まだセッションがありません。
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
