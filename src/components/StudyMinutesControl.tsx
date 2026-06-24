import { useState } from "react";

type StudyMinutesControlProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onValidityChange?: (isValid: boolean) => void;
  min?: number;
  max?: number;
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
  onValidityChange,
  min = 1,
  max = 720,
}: StudyMinutesControlProps) {
  const [inputValue, setInputValue] = useState(String(value));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function normalizeDigits(rawValue: string): string {
    return rawValue.replace(/[０-９]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
    );
  }

  function validate(rawValue: string): number | null {
    const normalized = normalizeDigits(rawValue).trim();
    if (!/^\d+$/.test(normalized)) {
      return null;
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      return null;
    }

    return parsed;
  }

  function setPreset(value: number) {
    setInputValue(String(value));
    setErrorMessage(null);
    onValidityChange?.(true);
    onChange(value);
  }

  function handleInputChange(rawValue: string) {
    const normalized = normalizeDigits(rawValue);
    if (!/^\d*$/.test(normalized)) {
      setErrorMessage(`${min}分以上${max}分以下の半角数字で入力してください`);
      onValidityChange?.(false);
      return;
    }

    setInputValue(normalized);
    const parsed = validate(normalized);
    if (parsed === null) {
      setErrorMessage(
        normalized.length === 0
          ? null
          : `${min}分以上${max}分以下の半角数字で入力してください`,
      );
      onValidityChange?.(false);
      return;
    }

    setErrorMessage(null);
    onValidityChange?.(true);
    onChange(parsed);
  }

  function handleBlur() {
    const parsed = validate(inputValue);
    if (parsed === null) {
      setErrorMessage(`${min}分以上${max}分以下の半角数字で入力してください`);
      onValidityChange?.(false);
      return;
    }

    setInputValue(String(parsed));
    setErrorMessage(null);
    onValidityChange?.(true);
    onChange(parsed);
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">{label}</span>
        <input
          type="text"
          inputMode="numeric"
          value={inputValue}
          onBlur={handleBlur}
          onChange={(event) => handleInputChange(event.target.value)}
          aria-invalid={errorMessage ? true : undefined}
          className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500 aria-invalid:border-red-400"
        />
      </label>
      {errorMessage ? <p className="text-sm text-red-700">{errorMessage}</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STUDY_TIME_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => setPreset(preset.value)}
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
