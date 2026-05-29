"use client";

import type { StudyQuality } from "@/lib/sessions/types";

const labels: Record<StudyQuality, string> = {
  1: "かなり悪い",
  2: "悪い",
  3: "普通",
  4: "良い",
  5: "とても良い",
};

type QualitySelectorProps = {
  value: StudyQuality;
  onChange: (value: StudyQuality) => void;
};

export function QualitySelector({ value, onChange }: QualitySelectorProps) {
  const qualities: StudyQuality[] = [1, 2, 3, 4, 5];

  return (
    <div className="grid grid-cols-5 gap-2">
      {qualities.map((quality) => (
        <button
          key={quality}
          type="button"
          onClick={() => onChange(quality)}
          className={`rounded-md border p-3 text-center text-sm transition ${
            value === quality
              ? "border-emerald-500 bg-emerald-50 text-emerald-900"
              : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
          }`}
        >
          <span className="block text-lg font-semibold">{quality}</span>
          <span className="mt-1 block text-xs">{labels[quality]}</span>
        </button>
      ))}
    </div>
  );
}
