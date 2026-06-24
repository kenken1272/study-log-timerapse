import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { getSession, getSessionForUser, toJsonSession } from "@/lib/sessions/firestore";
import { processTimelapse } from "@/lib/video/processTimelapse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cloud Run allows up to 3600 seconds; reserve a 60s buffer for cleanup
export const maxDuration = 3540;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const secret = process.env.INTERNAL_PROCESS_SECRET ?? "";
  const providedSecret = request.headers.get("x-internal-secret") ?? "";
  const { id } = await context.params;

  if (!secret || providedSecret !== secret) {
    try {
      const decodedToken = await requireAuthenticatedUser(request);
      const session = await getSessionForUser(id, decodedToken.uid);
      if (!session) {
        return NextResponse.json({ error: "Session not found." }, { status: 404 });
      }
    } catch (error) {
      return jsonError(error, 401);
    }
  }

  try {
    const sessionBeforeProcessing = await getSession(id);
    if (!sessionBeforeProcessing) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (sessionBeforeProcessing.status === "ready") {
      return NextResponse.json(
        { ok: true, session: toJsonSession(sessionBeforeProcessing) },
        { status: 200 },
      );
    }
    if (sessionBeforeProcessing.type !== "recorded") {
      return NextResponse.json(
        { error: "Only recorded sessions can be processed." },
        { status: 400 },
      );
    }

    await processTimelapse(id);
    const session = await getSession(id);
    return NextResponse.json(
      { ok: true, session: session ? toJsonSession(session) : null },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error(`[do-process] sessionId=${id} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
