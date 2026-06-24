import Link from "next/link";
import { Settings } from "lucide-react";
import type { DashboardStats } from "@/lib/sessions/types";
import { formatDuration } from "@/lib/time/format";

type WeeklyGoalCardProps = {
  stats: DashboardStats;
};

export function WeeklyGoalCard({ stats }: WeeklyGoalCardProps) {
  const percent = Math.min(100, stats.weeklyAchievementRate);
  const weeklyGoalHours = stats.targetWeeklyStudyMinutes / 60;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-500">週間目標</p>
          <h2 className="mt-1 text-xl font-semibold">
            {formatDuration(stats.weekStudySec)} / {weeklyGoalHours.toLocaleString("ja-JP")}時間
          </h2>
        </div>
        <Link
          href="/settings/weekly-goal"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
          title="週間目標設定"
        >
          <Settings size={18} />
        </Link>
      </div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-zinc-500">
        達成率 {Math.round(stats.weeklyAchievementRate)}%
      </p>
    </section>
  );
}
