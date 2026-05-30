type StudyMinutesControlProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
};

const STUDY_TIME_PRESETS = [
  { label: "30分", value: 30 },
  { label: "1時間", value: 60 },
  { label: "2時間", value: 120 },
  { label: "3時間", value: 180 },
];

export function StudyMinutesControl({
  label,
  value,
  onChange,
  min = 1,
}: StudyMinutesControlProps) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">{label}</span>
        <input
          type="number"
          min={min}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
        />
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STUDY_TIME_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            aria-pressed={value === preset.value}
            className={
              value === preset.value
                ? "rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800"
                : "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            }
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
