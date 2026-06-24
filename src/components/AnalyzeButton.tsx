"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { JsonStudySession } from "@/lib/sessions/types";

type AnalyzeButtonProps = {
  session: JsonStudySession;
  onAnalyzed?: (session: JsonStudySession) => void;
  compact?: boolean;
};

function labelForStatus(status: JsonStudySession["analysisStatus"]): string {
  if (status === "done") {
    return "AI分析を再実行";
  }
  if (status === "failed") {
    return "AI分析を再実行";
  }
  if (status === "processing") {
    return "AI分析中";
  }

  return "AI分析を実行";
}

export function AnalyzeButton({ session, onAnalyzed, compact = false }: AnalyzeButtonProps) {
  const router = useRouter();
  const { authFetch } = useAuth();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const canAnalyze = session.status === "ready" && session.timelapsePath !== null;
  const canRunAnalysis =
    canAnalyze && !isAnalyzing && session.analysisStatus !== "processing";

  async function handleAnalyze() {
    setIsAnalyzing(true);
    setErrorMessage(null);
    try {
      const response = await authFetch(`/api/sessions/${session.id}/analyze`, {
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
      <button
        type="button"
        onClick={handleAnalyze}
        disabled={!canRunAnalysis}
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
