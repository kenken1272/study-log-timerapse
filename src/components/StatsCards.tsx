import type { DashboardStats } from "@/lib/sessions/types";
import { formatDuration } from "@/lib/time/format";

type StatsCardsProps = {
  stats: DashboardStats;
};

export function StatsCards({ stats }: StatsCardsProps) {
  const weeklyGoalHours = stats.targetWeeklyStudyMinutes / 60;
  const cards = [
    { label: "今日", value: formatDuration(stats.todayStudySec) },
    { label: "今週", value: formatDuration(stats.weekStudySec) },
    { label: "週間目標", value: `${weeklyGoalHours.toLocaleString("ja-JP")}時間` },
    { label: "達成率", value: `${Math.round(stats.weeklyAchievementRate)}%` },
    { label: "総勉強時間", value: formatDuration(stats.totalStudySec) },
    { label: "総休憩時間", value: formatDuration(stats.totalBreakSec) },
    { label: "総セッション", value: `${stats.totalSessions}回` },
    {
      label: "平均クオリティ",
      value: stats.averageQuality === null ? "-" : stats.averageQuality.toFixed(1),
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">{card.label}</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-950">{card.value}</p>
        </div>
      ))}
    </section>
  );
}
