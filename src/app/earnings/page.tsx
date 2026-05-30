"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeJapaneseYen,
  Flame,
  JapaneseYen,
  Sparkles,
  TrendingUp,
  Trophy,
} from "lucide-react";
import type { DashboardStats } from "@/lib/sessions/types";
import { formatDuration } from "@/lib/time/format";

const HOURLY_RATE_YEN = 10_000;

type EarningsState = {
  stats: DashboardStats | null;
  error: string | null;
};

function earnedYen(seconds: number): number {
  return Math.round((seconds / 3600) * HOURLY_RATE_YEN);
}

function formatYen(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

function nextThousandMilestone(seconds: number): {
  nextValue: number;
  remainingSec: number;
  progress: number;
} {
  const currentValue = earnedYen(seconds);
  const remainder = currentValue % 1000;
  const remainingValue = remainder === 0 ? 1000 : 1000 - remainder;
  const nextValue = currentValue + remainingValue;
  const remainingSec = Math.ceil((remainingValue / HOURLY_RATE_YEN) * 3600);
  const progress = ((1000 - remainingValue) / 1000) * 100;

  return { nextValue, remainingSec, progress };
}

function EarningsCard({
  label,
  seconds,
  tone,
  caption,
}: {
  label: string;
  seconds: number;
  tone: "amber" | "emerald" | "sky";
  caption: string;
}) {
  const toneClasses = {
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
  };

  return (
    <div className={`rounded-lg border p-5 ${toneClasses[tone]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-3 text-4xl font-semibold tracking-normal">
        {formatYen(earnedYen(seconds))}
      </p>
      <p className="mt-3 text-sm opacity-75">{formatDuration(seconds)}</p>
      <p className="mt-2 text-sm font-medium">{caption}</p>
    </div>
  );
}

export default function EarningsPage() {
  const [state, setState] = useState<EarningsState>({
    stats: null,
    error: null,
  });

  useEffect(() => {
    async function loadStats() {
      try {
        const response = await fetch("/api/sessions/stats", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("換算データを読み込めませんでした。");
        }
        const body = (await response.json()) as { stats: DashboardStats };
        setState({ stats: body.stats, error: null });
      } catch (error) {
        setState({
          stats: null,
          error: error instanceof Error ? error.message : "読み込みに失敗しました。",
        });
      }
    }

    void loadStats();
  }, []);

  const stats = state.stats;
  const weeklyGoalSec = stats ? stats.targetWeeklyStudyMinutes * 60 : 0;
  const weeklyGoalValue = earnedYen(weeklyGoalSec);
  const weeklyProgress =
    stats && weeklyGoalSec > 0 ? Math.min(100, (stats.weekStudySec / weeklyGoalSec) * 100) : 0;
  const nextHourValue = stats ? earnedYen(stats.todayStudySec + 3600) : HOURLY_RATE_YEN;
  const todayValue = stats ? earnedYen(stats.todayStudySec) : 0;
  const milestone = stats
    ? nextThousandMilestone(stats.todayStudySec)
    : { nextValue: 1000, remainingSec: 6 * 60, progress: 0 };

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
        >
          <ArrowLeft size={16} />
          ダッシュボードへ
        </Link>

        <header className="rounded-lg bg-zinc-950 p-6 text-white md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm text-amber-100">
                <BadgeJapaneseYen size={16} />
                6分で +¥1,000 / 1時間で {formatYen(HOURLY_RATE_YEN)}
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-normal md:text-5xl">
                今日の勉強、ちゃんと価値になってる
              </h1>
              <p className="mt-4 max-w-2xl text-zinc-300">
                勉強時間を未来の時給で見える化。積んだ時間は、あとから効いてくる資産です。
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/10 p-5 lg:min-w-72">
              <p className="text-sm text-zinc-300">今日の積み上げ価値</p>
              <p className="mt-2 text-5xl font-semibold tracking-normal text-amber-200">
                {formatYen(todayValue)}
              </p>
              <p className="mt-3 text-sm text-zinc-300">
                ここから1時間やると {formatYen(nextHourValue)}
              </p>
            </div>
          </div>
        </header>

        {state.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {state.error}
          </div>
        ) : null}

        {stats ? (
          <>
            <section className="grid gap-4 md:grid-cols-3">
              <EarningsCard
                label="今日の未来価値"
                seconds={stats.todayStudySec}
                tone="amber"
                caption="今日の一歩が、あとで効く"
              />
              <EarningsCard
                label="今週の未来価値"
                seconds={stats.weekStudySec}
                tone="emerald"
                caption="週間の積み上げが見えてる"
              />
              <EarningsCard
                label="累計の未来価値"
                seconds={stats.totalStudySec}
                tone="sky"
                caption="もうここまで積んだ"
              />
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <div className="flex items-center gap-2">
                  <Trophy className="text-amber-500" size={22} />
                  <h2 className="text-xl font-semibold">今週の積み上げ</h2>
                </div>
                <div className="mt-5 h-4 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${weeklyProgress}%` }}
                  />
                </div>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <div className="rounded-lg bg-zinc-50 p-3">
                    <p className="text-zinc-500">今週の換算</p>
                    <p className="mt-1 text-lg font-semibold">
                      {formatYen(earnedYen(stats.weekStudySec))}
                    </p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 p-3">
                    <p className="text-zinc-500">週間目標の価値</p>
                    <p className="mt-1 text-lg font-semibold">
                      {weeklyGoalSec > 0 ? formatYen(weeklyGoalValue) : "-"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 p-3">
                    <p className="text-zinc-500">達成率</p>
                    <p className="mt-1 text-lg font-semibold">
                      {Math.round(stats.weeklyAchievementRate)}%
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-amber-200 bg-white p-5">
                <div className="flex items-center gap-2">
                  <Flame className="text-red-500" size={22} />
                  <h2 className="text-xl font-semibold">次の+¥1,000まで</h2>
                </div>
                <p className="mt-5 text-sm text-zinc-500">あと</p>
                <p className="mt-2 text-4xl font-semibold tracking-normal text-amber-700">
                  {formatDuration(milestone.remainingSec)}
                </p>
                <div className="mt-5 h-3 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${milestone.progress}%` }}
                  />
                </div>
                <p className="mt-3 text-sm text-zinc-500">
                  到達すると今日の換算は {formatYen(milestone.nextValue)}
                </p>
                <div className="mt-5 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-amber-950">
                  <Sparkles size={18} />
                  <span className="text-sm font-medium">ちょっとだけ続ける理由がある</span>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white p-5">
              <div className="flex items-center gap-2">
                <TrendingUp className="text-emerald-600" size={22} />
                <h2 className="text-xl font-semibold">累計インパクト</h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-sm text-zinc-500">累計勉強時間</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {formatDuration(stats.totalStudySec)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500">換算額</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {formatYen(earnedYen(stats.totalStudySec))}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500">平均クオリティ</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {stats.averageQuality === null ? "-" : stats.averageQuality.toFixed(1)}
                  </p>
                </div>
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <p className="text-sm font-medium text-zinc-500">今日のミッション</p>
                <p className="mt-3 text-lg font-semibold">まず6分だけ追加</p>
                <p className="mt-2 text-sm text-zinc-500">+¥1,000の感覚を作る</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <p className="text-sm font-medium text-zinc-500">今週のミッション</p>
                <p className="mt-3 text-lg font-semibold">目標価値まで寄せる</p>
                <p className="mt-2 text-sm text-zinc-500">
                  週間目標は {weeklyGoalSec > 0 ? formatYen(weeklyGoalValue) : "-"} の価値
                </p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <p className="text-sm font-medium text-zinc-500">未来へのメモ</p>
                <p className="mt-3 text-lg font-semibold">勉強した自分は裏切らない</p>
                <p className="mt-2 text-sm text-zinc-500">今日の記録が、明日の自信になる</p>
              </div>
            </section>
          </>
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            読み込み中...
          </div>
        )}

        <Link
          href="/sessions/new"
          className="inline-flex w-fit items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800"
        >
          <JapaneseYen size={18} />
          勉強して増やす
        </Link>
      </div>
    </main>
  );
}
