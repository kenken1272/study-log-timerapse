import { after, NextResponse } from "next/server";
import { analyzeStudyVideo, getVertexModelName } from "@/lib/vertex/analyzeStudyVideo";
import {
  getSession,
  toJsonSession,
  updateSessionAnalysisDone,
  updateSessionAnalysisFailed,
  updateSessionAnalysisProcessing,
} from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const model = getVertexModelName();

  try {
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (session.status !== "ready" || !session.timelapsePath) {
      return NextResponse.json(
        { error: "Timelapse video must be ready before analysis." },
        { status: 400 },
      );
    }
    if (session.analysisStatus === "processing") {
      return NextResponse.json(
        { ok: true, session: toJsonSession(session) },
        { status: 202 },
      );
    }

    await updateSessionAnalysisProcessing({ sessionId: id, model });
    const timelapsePath = session.timelapsePath;
    after(async () => {
      try {
        const analysis = await analyzeStudyVideo(timelapsePath);
        await updateSessionAnalysisDone({
          sessionId: id,
          model: analysis.model,
          analysisResult: analysis.result,
        });
      } catch (analysisError) {
        const message =
          analysisError instanceof Error ? analysisError.message : "Analysis failed.";
        await updateSessionAnalysisFailed({ sessionId: id, model, errorMessage: message });
      }
    });

    const updated = await getSession(id);
    if (!updated) {
      return NextResponse.json({ error: "Session not found after analysis." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, session: toJsonSession(updated) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    await updateSessionAnalysisFailed({ sessionId: id, model, errorMessage: message }).catch(
      () => undefined,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
