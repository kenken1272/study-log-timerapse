import type {
  LocalAnalysisReport,
  LocalAnalysisState,
  LocalAnalysisStatus,
} from "@/lib/analysis/localAnalysis";

type LocalAnalysisCardProps = {
  state: LocalAnalysisState;
  status: LocalAnalysisStatus | null;
  report: LocalAnalysisReport | null;
};

const TREND_LABELS: Record<LocalAnalysisReport["concentration"]["trend"], string> = {
  improving: "上昇傾向",
  declining: "低下傾向",
  stable: "安定",
  fluctuating: "変動が大きい",
  unknown: "判定できず",
};

// The score is inferred from what the camera can see, not measured. The panel
// says so wherever a number is shown.
const ESTIMATE_NOTICE =
  "この分析は、着席の継続、手や姿勢の動き、スマートフォン操作、離席など" +
  "映像から観察できる手掛かりに基づく推定です。集中力そのものを測定した値ではありません。";

function formatTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function Progress({ status }: { status: LocalAnalysisStatus }) {
  if (status.chunks_total === 0) {
    return null;
  }

  const percent = Math.round((status.chunks_completed / status.chunks_total) * 100);
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <div className="h-full rounded-full bg-zinc-800" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-zinc-500">
        {status.chunks_completed} / {status.chunks_total} チャンク分析済み
        {status.chunks_failed > 0 ? `（失敗 ${status.chunks_failed}）` : ""}
      </p>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-zinc-700">{title}</p>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((item, index) => (
          <li key={index} className="break-words text-sm text-zinc-700">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocalAnalysisCard({ state, status, report }: LocalAnalysisCardProps) {
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-zinc-800">ローカルAI分析</p>
      {report?.runtime.used_model ? (
        <p className="text-xs text-zinc-500">モデル: {report.runtime.used_model}</p>
      ) : null}
    </div>
  );

  if (state === "queued") {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">
          分析待ちです。録画したチャンクが順番に処理されます。
        </p>
      </div>
    );
  }

  if (state === "processing" || state === "partial") {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">
          {state === "processing"
            ? "分析中です。30分ごとに区切って処理されます。"
            : "一部の区間まで分析が完了しています。"}
        </p>
        {status ? <Progress status={status} /> : null}
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div className="space-y-3">
        {header}
        <p className="whitespace-pre-wrap break-words text-sm text-red-700">
          {status?.message ?? "ローカルAI分析に失敗しました。"}
        </p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-zinc-500">分析結果を読み込めませんでした。</p>
      </div>
    );
  }

  const coveragePercent = Math.round(report.data_quality.coverage_ratio * 100);

  return (
    <div className="space-y-4">
      {header}

      <p className="whitespace-pre-wrap break-words text-sm text-zinc-700">
        {report.summary}
      </p>

      <div className="flex flex-wrap gap-4 rounded-lg bg-zinc-50 p-3">
        <div>
          <p className="text-xs text-zinc-500">推定集中スコア</p>
          <p className="text-lg font-semibold text-zinc-900">
            {Math.round(report.concentration.average_score)}
            <span className="text-sm font-normal text-zinc-500"> / 100</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">推移</p>
          <p className="text-lg font-semibold text-zinc-900">
            {TREND_LABELS[report.concentration.trend]}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">分析できた割合</p>
          <p className="text-lg font-semibold text-zinc-900">
            {coveragePercent}
            <span className="text-sm font-normal text-zinc-500">%</span>
          </p>
        </div>
      </div>

      {report.concentration.low_periods.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-zinc-700">集中が下がっていた時間帯</p>
          <ul className="space-y-1">
            {report.concentration.low_periods.map((period, index) => (
              <li key={index} className="break-words text-sm text-zinc-700">
                {formatTime(period.start)}–{formatTime(period.end)}
                {period.note ? ` ${period.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Section title="観察された傾向" items={report.observed_patterns} />
      <Section title="ボトルネック" items={report.bottlenecks} />

      {report.recommendations.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-700">改善案</p>
          {report.recommendations.map((recommendation, index) => (
            <div key={index} className="rounded-lg border border-zinc-200 p-3">
              <p className="text-sm font-semibold text-zinc-800">
                {recommendation.priority}. {recommendation.title}
              </p>
              {recommendation.reason ? (
                <p className="mt-1 break-words text-xs text-zinc-500">
                  根拠: {recommendation.reason}
                </p>
              ) : null}
              {recommendation.action ? (
                <p className="mt-1 break-words text-sm text-zinc-700">
                  次回: {recommendation.action}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {report.data_quality.warnings.length > 0 ? (
        <div className="space-y-1 rounded-lg bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-900">データに関する注意</p>
          <ul className="list-disc space-y-1 pl-5">
            {report.data_quality.warnings.map((warning, index) => (
              <li key={index} className="break-words text-xs text-amber-900">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1 border-t border-zinc-200 pt-3">
        <p className="text-xs text-zinc-500">{ESTIMATE_NOTICE}</p>
        {report.runtime.fallback_used ? (
          <p className="text-xs text-zinc-500">
            要求モデル {report.runtime.requested_model} は使用できず、
            {report.runtime.used_model} で分析しました。
          </p>
        ) : null}
        {report.window.missing_chunk_count > 0 ? (
          <p className="text-xs text-zinc-500">
            欠損 {report.window.missing_chunk_count} チャンク（分析対象{" "}
            {report.window.chunk_count} チャンク）
          </p>
        ) : null}
      </div>
    </div>
  );
}
