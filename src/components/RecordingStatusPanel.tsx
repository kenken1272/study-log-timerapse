import { Pause, Square } from "lucide-react";
import { formatDuration } from "@/lib/time/format";

type RecordingStatusPanelProps = {
  actualStudySec: number;
  targetStudySec: number;
  isBreakActive: boolean;
  isBusy: boolean;
  onToggleBreak: () => void;
  onStop: () => void;
};

export function RecordingStatusPanel({
  actualStudySec,
  targetStudySec,
  isBreakActive,
  isBusy,
  onToggleBreak,
  onStop,
}: RecordingStatusPanelProps) {
  const progress = targetStudySec > 0 ? Math.min(100, (actualStudySec / targetStudySec) * 100) : 0;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-500">
            {isBreakActive ? "休憩中" : "勉強中"}
          </p>
          <p className="mt-2 text-5xl font-semibold tracking-normal text-zinc-950">
            {formatDuration(actualStudySec)}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onToggleBreak}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          >
            <Pause size={18} />
            {isBreakActive ? "休憩終了" : "休憩開始"}
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            <Square size={18} />
            停止
          </button>
        </div>
      </div>
      <div className="mt-6 h-3 overflow-hidden rounded-full bg-zinc-100">
        <div className="h-full bg-emerald-500" style={{ width: `${progress}%` }} />
      </div>
      <p className="mt-3 text-sm text-amber-700">このタブを閉じないでください</p>
    </section>
  );
}
