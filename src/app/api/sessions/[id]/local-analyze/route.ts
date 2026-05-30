import { after, NextResponse } from "next/server";
import { createSignedReadUrl } from "@/lib/gcp/storage";
import {
  getSession,
  toJsonSession,
  updateSessionLocalAnalysisDone,
  updateSessionLocalAnalysisFailed,
  updateSessionLocalAnalysisProcessing,
} from "@/lib/sessions/firestore";
import {
  LOCAL_ANALYSIS_PROMPT,
  requestLocalVideoAnalysis,
} from "@/lib/localAnalysis/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function parseFps(value: string | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function parseMaxPixels(value: string | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 151200;
}

function parseSegmentSeconds(value: string | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseMaxSegments(value: string | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;

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
    if (session.localAnalysisStatus === "processing") {
      return NextResponse.json(
        { ok: true, session: toJsonSession(session) },
        { status: 202 },
      );
    }

    await updateSessionLocalAnalysisProcessing({ sessionId: id });

    const videoUrl = await createSignedReadUrl(session.timelapsePath);
    const fps = parseFps(process.env.LOCAL_ANALYSIS_FPS);
    const maxPixels = parseMaxPixels(process.env.LOCAL_ANALYSIS_MAX_PIXELS);
    const segmentSeconds = parseSegmentSeconds(process.env.LOCAL_ANALYSIS_SEGMENT_SECONDS);
    const maxSegments = parseMaxSegments(process.env.LOCAL_ANALYSIS_MAX_SEGMENTS);

    after(async () => {
      try {
        const analysis = await requestLocalVideoAnalysis({
          sessionId: id,
          videoUrl,
          prompt: LOCAL_ANALYSIS_PROMPT,
          fps,
          maxPixels,
          segmentSeconds,
          maxSegments,
        });

        await updateSessionLocalAnalysisDone({
          sessionId: id,
          model: analysis.model ?? "Qwen/Qwen2.5-VL-7B-Instruct",
          analysisResult: analysis.result,
        });
      } catch (analysisError) {
        const message =
          analysisError instanceof Error ? analysisError.message : "Local analysis failed.";
        await updateSessionLocalAnalysisFailed({ sessionId: id, errorMessage: message });
      }
    });

    const updated = await getSession(id);
    if (!updated) {
      return NextResponse.json({ error: "Session not found after analysis." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, session: toJsonSession(updated) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local analysis failed.";
    await updateSessionLocalAnalysisFailed({ sessionId: id, errorMessage: message }).catch(
      () => undefined,
    );
    const updated = await getSession(id).catch(() => null);
    return NextResponse.json(
      {
        error: message,
        session: updated ? toJsonSession(updated) : null,
      },
      { status: 500 },
    );
  }
}
