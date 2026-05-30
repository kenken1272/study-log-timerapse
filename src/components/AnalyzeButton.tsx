"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import type { JsonStudySession } from "@/lib/sessions/types";

const GEMINI_ANALYSIS_CODE = "1272";

type AnalyzeButtonProps = {
  session: JsonStudySession;
  onAnalyzed?: (session: JsonStudySession) => void;
  compact?: boolean;
};

function labelForStatus(status: JsonStudySession["analysisStatus"]): string {
  if (status === "done") {
    return "再分析";
  }
  if (status === "failed") {
    return "分析再実行";
  }
  if (status === "processing") {
    return "分析中";
  }

  return "Geminiで集中度分析";
}

export function AnalyzeButton({ session, onAnalyzed, compact = false }: AnalyzeButtonProps) {
  const router = useRouter();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisCode, setAnalysisCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const canAnalyze = session.status === "ready" && session.timelapsePath !== null;
  const canRunGeminiAnalysis = canAnalyze && analysisCode.trim() === GEMINI_ANALYSIS_CODE;

  async function handleAnalyze() {
    if (!canRunGeminiAnalysis) {
      setErrorMessage("Gemini集中度判定コードを入力してください。");
      return;
    }

    setIsAnalyzing(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}/analyze`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        session?: JsonStudySession | null;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "分析に失敗しました。");
      }

      if (body.session) {
        onAnalyzed?.(body.session);
      }
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "分析に失敗しました。");
      router.refresh();
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="block max-w-xs">
        <span className="text-sm font-medium text-zinc-700">Gemini判定コード</span>
        <input
          type="password"
          inputMode="numeric"
          value={analysisCode}
          onChange={(event) => setAnalysisCode(event.target.value)}
          className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
        />
      </label>
      <button
        type="button"
        onClick={handleAnalyze}
        disabled={
          !canAnalyze ||
          !canRunGeminiAnalysis ||
          isAnalyzing ||
          session.analysisStatus === "processing"
        }
        className={
          compact
            ? "inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            : "inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-50"
        }
      >
        <Sparkles size={compact ? 16 : 18} />
        {isAnalyzing ? "分析開始中" : labelForStatus(session.analysisStatus)}
      </button>
      {errorMessage ? (
        <p className="max-w-xl whitespace-pre-wrap break-words text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
