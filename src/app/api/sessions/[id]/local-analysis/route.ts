import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { readLocalAnalysis } from "@/lib/analysis/localAnalysis";
import { getSessionForUser } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Serves the Ubuntu worker's analysis for the signed-in user's own session.
 *
 * The bucket stays private: objects are read server-side with the service
 * account and returned as JSON. The uid used to build the object path comes
 * from the verified ID token, never from the request.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;

    // Ownership check first: without this, any signed-in user could read
    // another user's analysis by guessing a session id.
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    const { status, report } = await readLocalAnalysis(decodedToken.uid, id);

    if (!status && !report) {
      return NextResponse.json(
        { state: "queued", status: null, report: null },
        { status: 200 },
      );
    }

    // A finished report is authoritative even if the status file lags behind.
    const state = report ? "ready" : (status?.state ?? "queued");

    return NextResponse.json({ state, status, report }, { status: 200 });
  } catch (error) {
    return jsonError(error, 401);
  }
}
