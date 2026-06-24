import { after, NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { analyzeStudyVideo, getVertexModelName } from "@/lib/vertex/analyzeStudyVideo";
import {
  getSessionForUser,
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

export async function POST(request: Request, context: RouteContext) {
  let id = "";
  const model = getVertexModelName();

  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const params = await context.params;
    id = params.id;
    const session = await getSessionForUser(id, decodedToken.uid);
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

    const updated = await getSessionForUser(id, decodedToken.uid);
    if (!updated) {
      return NextResponse.json({ error: "Session not found after analysis." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, session: toJsonSession(updated) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    if (id) {
      await updateSessionAnalysisFailed({ sessionId: id, model, errorMessage: message }).catch(
        () => undefined,
      );
    }
    return jsonError(error, 500);
  }
}
