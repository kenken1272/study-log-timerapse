import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { getSessionForUser } from "@/lib/sessions/firestore";
import { cleanupSessionChunks } from "@/lib/video/cleanupChunks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Deletes a session's source chunks after the analysis grace period.
 *
 * Normally invoked by a delayed Cloud Task scheduled at the end of
 * processTimelapse. Also callable by the session owner to reclaim storage
 * early.
 */
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
    const result = await cleanupSessionChunks(id);
    if (result.skipped) {
      console.log(`[cleanup-chunks] sessionId=${id} skipped: ${result.reason}`);
    } else {
      console.log(`[cleanup-chunks] sessionId=${id} deleted ${result.deletedCount} chunks`);
    }

    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cleanup error.";
    console.error(`[cleanup-chunks] sessionId=${id} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
