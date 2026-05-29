"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save } from "lucide-react";

export default function WeeklyGoalSettingsPage() {
  const [unit, setUnit] = useState<"hours" | "minutes">("hours");
  const [value, setValue] = useState(10);
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    async function loadGoal() {
      const response = await fetch("/api/settings/weekly-goal", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { targetWeeklyStudyMinutes: number };
      if (body.targetWeeklyStudyMinutes >= 60 && body.targetWeeklyStudyMinutes % 60 === 0) {
        setUnit("hours");
        setValue(body.targetWeeklyStudyMinutes / 60);
      } else {
        setUnit("minutes");
        setValue(body.targetWeeklyStudyMinutes);
      }
    }

    void loadGoal();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage(null);
    try {
      const targetWeeklyStudyMinutes = unit === "hours" ? value * 60 : value;
      const response = await fetch("/api/settings/weekly-goal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetWeeklyStudyMinutes }),
      });
      if (!response.ok) {
        throw new Error("保存に失敗しました。");
      }
      setMessage("週間目標を保存しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 md:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-950"
        >
          <ArrowLeft size={16} />
          ダッシュボードへ
        </Link>
        <header className="my-8">
          <h1 className="text-3xl font-semibold tracking-normal">週間目標設定</h1>
        </header>
        <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">目標勉強時間</span>
            <input
              type="number"
              min={0}
              value={value}
              onChange={(event) => setValue(Number(event.target.value))}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
          <div className="inline-flex rounded-md border border-zinc-300 bg-white p-1">
            <button
              type="button"
              onClick={() => setUnit("hours")}
              className={`rounded px-4 py-2 text-sm ${
                unit === "hours" ? "bg-zinc-950 text-white" : "text-zinc-700"
              }`}
            >
              時間
            </button>
            <button
              type="button"
              onClick={() => setUnit("minutes")}
              className={`rounded px-4 py-2 text-sm ${
                unit === "minutes" ? "bg-zinc-950 text-white" : "text-zinc-700"
              }`}
            >
              分
            </button>
          </div>
          <button
            type="submit"
            disabled={isSaving}
            className="flex w-fit items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            <Save size={18} />
            保存
          </button>
          {message ? <p className="text-sm text-zinc-600">{message}</p> : null}
        </form>
      </div>
    </main>
  );
}
