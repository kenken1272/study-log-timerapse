"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import type { JsonStudySession } from "@/lib/sessions/types";

type LocalAnalyzeButtonProps = {
  session: JsonStudySession;
  onAnalyzed?: (session: JsonStudySession) => void;
};

function labelForStatus(status: JsonStudySession["localAnalysisStatus"]): string {
  if (status === "done") {
    return "ローカル再分析";
  }
  if (status === "failed") {
    return "ローカル分析再実行";
  }
  if (status === "processing") {
    return "ローカル分析中";
  }

  return "ローカル分析";
}

export function LocalAnalyzeButton({ session, onAnalyzed }: LocalAnalyzeButtonProps) {
  const router = useRouter();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const canAnalyze = session.status === "ready" && session.timelapsePath !== null;

  async function handleAnalyze() {
    setIsAnalyzing(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}/local-analyze`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        session?: JsonStudySession | null;
      };
      if (!response.ok) {
        if (body.session) {
          onAnalyzed?.(body.session);
        }
        throw new Error(body.error ?? "ローカル分析に失敗しました。");
      }

      if (body.session) {
        onAnalyzed?.(body.session);
      }
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "ローカル分析に失敗しました。",
      );
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
        disabled={!canAnalyze || isAnalyzing || session.localAnalysisStatus === "processing"}
        className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        <Sparkles size={18} />
        {isAnalyzing ? "ローカル分析開始中" : labelForStatus(session.localAnalysisStatus)}
      </button>
      {errorMessage ? (
        <p className="max-w-xl whitespace-pre-wrap break-words text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
