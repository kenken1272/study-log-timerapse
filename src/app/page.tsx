"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Clock, Plus } from "lucide-react";
import { AuthControls } from "@/components/auth/AuthControls";
import { AuthGate } from "@/components/auth/AuthGate";
import { SessionCard } from "@/components/SessionCard";
import { StatsCards } from "@/components/StatsCards";
import { WeeklyGoalCard } from "@/components/WeeklyGoalCard";
import { useAuth } from "@/hooks/use-auth";
import type { DashboardStats, JsonStudySession } from "@/lib/sessions/types";

type DashboardState = {
  stats: DashboardStats | null;
  sessions: JsonStudySession[];
  nextCursor: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
};

export default function DashboardPage() {
  const { authFetch, isLoading: isAuthLoading, profileError, user } = useAuth();
  const [state, setState] = useState<DashboardState>({
    stats: null,
    sessions: [],
    nextCursor: null,
    isLoading: true,
    isLoadingMore: false,
    error: null,
  });

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }
    if (!user) {
      setState({
        stats: null,
        sessions: [],
        nextCursor: null,
        isLoading: false,
        isLoadingMore: false,
        error: null,
      });
      return;
    }

    async function loadDashboard() {
      setState((current) => ({ ...current, isLoading: true, error: null }));
      try {
        const [statsResponse, sessionsResponse] = await Promise.all([
          authFetch("/api/sessions/stats", { cache: "no-store" }),
          authFetch("/api/sessions?limit=30", { cache: "no-store" }),
        ]);
        if (!statsResponse.ok || !sessionsResponse.ok) {
          throw new Error("ダッシュボードを読み込めませんでした。");
        }
        const statsBody = (await statsResponse.json()) as { stats: DashboardStats };
        const sessionsBody = (await sessionsResponse.json()) as {
          sessions: JsonStudySession[];
          nextCursor: string | null;
        };
        setState({
          stats: statsBody.stats,
          sessions: sessionsBody.sessions,
          nextCursor: sessionsBody.nextCursor,
          isLoading: false,
          isLoadingMore: false,
          error: null,
        });
      } catch (error) {
        setState((current) => ({
          ...current,
          isLoading: false,
          error: error instanceof Error ? error.message : "読み込みに失敗しました。",
        }));
      }
    }

    void loadDashboard();
  }, [authFetch, isAuthLoading, user]);

  async function handleLoadMore() {
    if (!state.nextCursor || state.isLoadingMore) {
      return;
    }

    setState((current) => ({ ...current, isLoadingMore: true, error: null }));
    try {
      const response = await authFetch(
        `/api/sessions?limit=30&cursor=${encodeURIComponent(state.nextCursor)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error("追加のセッションを読み込めませんでした。");
      }
      const body = (await response.json()) as {
        sessions: JsonStudySession[];
        nextCursor: string | null;
      };
      setState((current) => ({
        ...current,
        sessions: [...current.sessions, ...body.sessions],
        nextCursor: body.nextCursor,
        isLoadingMore: false,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        isLoadingMore: false,
        error: error instanceof Error ? error.message : "読み込みに失敗しました。",
      }));
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-700">Study Timelapse</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {user ? (
              <>
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
              </>
            ) : null}
            <AuthControls />
          </div>
        </header>

        {profileError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {profileError}
          </div>
        ) : null}

        {!user && !isAuthLoading ? <AuthGate /> : null}

        {state.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {state.error}
          </div>
        ) : null}

        {user && state.stats ? (
          <section className="space-y-3">
            <StatsCards stats={state.stats} />
            <WeeklyGoalCard stats={state.stats} />
          </section>
        ) : user && state.isLoading ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            読み込み中...
          </div>
        ) : null}

        {user ? (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <BookOpen size={20} />
            <h2 className="text-xl font-semibold">学習ログ</h2>
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
          {state.nextCursor ? (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={state.isLoadingMore}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
              >
                {state.isLoadingMore ? "読み込み中..." : "さらに読み込む"}
              </button>
            </div>
          ) : null}
        </section>
        ) : null}
      </div>
    </main>
  );
}
