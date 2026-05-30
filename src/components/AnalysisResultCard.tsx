import type { AnalysisResult, AnalysisStatus } from "@/lib/sessions/types";

type AnalysisResultCardProps = {
  status: AnalysisStatus;
  result: AnalysisResult | null;
  errorMessage: string | null;
  title?: string;
  model?: string | null;
};

function minutes(value: number): string {
  return `${Math.round(value)}分`;
}

export function AnalysisResultCard({
  status,
  result,
  errorMessage,
  title,
  model,
}: AnalysisResultCardProps) {
  const header = title || model ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {title ? <p className="text-sm font-semibold text-zinc-800">{title}</p> : null}
      {model ? <p className="text-xs text-zinc-500">モデル: {model}</p> : null}
    </div>
  ) : null;

  if (status === "none" || status === "pending") {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">まだ分析されていません。</p>
      </div>
    );
  }
  if (status === "processing") {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">分析中です。数分かかる場合があります。</p>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="space-y-3">
        {header}
        <p className="whitespace-pre-wrap break-words text-sm text-red-700">
          {errorMessage ?? "分析に失敗しました。"}
        </p>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">分析結果がありません。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg bg-emerald-50 p-4 text-emerald-950">
          <p className="text-sm opacity-75">集中度</p>
          <p className="mt-1 text-3xl font-semibold">{result.focusScore}点</p>
          <p className="mt-1 text-sm font-medium">{result.focusLabel}</p>
        </div>
        <div className="rounded-lg bg-zinc-50 p-4">
          <p className="text-sm text-zinc-500">勉強検出</p>
          <p className="mt-1 text-lg font-semibold">
            {result.studyDetected ? "あり" : "不明"}
          </p>
        </div>
        <div className="rounded-lg bg-zinc-50 p-4">
          <p className="text-sm text-zinc-500">離席推定</p>
          <p className="mt-1 text-lg font-semibold">
            {minutes(result.estimatedAbsenceMinutes)}
          </p>
        </div>
        <div className="rounded-lg bg-zinc-50 p-4">
          <p className="text-sm text-zinc-500">読み書き推定</p>
          <p className="mt-1 text-lg font-semibold">
            {minutes(result.estimatedWritingReadingMinutes)}
          </p>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">要約</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-700">{result.summary}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="font-semibold">根拠</h3>
          <ul className="mt-2 space-y-2 text-sm text-zinc-700">
            {result.evidence.map((item) => (
              <li key={item}>・{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">アドバイス</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-700">{result.advice}</p>
          <h3 className="mt-4 font-semibold">不確実性</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-700">{result.uncertainty}</p>
          <p className="mt-4 text-sm text-zinc-500">
            推定スマホ操作: {minutes(result.estimatedPhoneUseMinutes)}
          </p>
        </div>
      </div>
    </div>
  );
}
