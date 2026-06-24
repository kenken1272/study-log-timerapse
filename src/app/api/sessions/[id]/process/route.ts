import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { enqueueTimelapseProcessingTask } from "@/lib/gcp/tasks";
import {
  getSessionForUser,
  toJsonSession,
  updateSessionFailed,
  updateSessionProcessing,
} from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (session.status === "processing") {
      return NextResponse.json(
        { ok: true, session: toJsonSession(session) },
        { status: 202 },
      );
    }
    if (session.status === "ready") {
      return NextResponse.json({ ok: true, session: toJsonSession(session) });
    }
    if (session.type !== "recorded") {
      return NextResponse.json(
        { error: "Only recorded sessions can be processed." },
        { status: 400 },
      );
    }

    await updateSessionProcessing(id);
    try {
      await enqueueTimelapseProcessingTask(id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "タイムラプス生成を開始できませんでした。";
      await updateSessionFailed(id, message);
      throw error;
    }

    const updated = await getSessionForUser(id, decodedToken.uid);
    return NextResponse.json(
      { ok: true, session: updated ? toJsonSession(updated) : null },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error, 500);
  }
}
