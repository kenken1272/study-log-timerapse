import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { getSessionForUser, resumeSession } from "@/lib/sessions/firestore";

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
    const segmentIndex = await resumeSession(id);
    return NextResponse.json({ segmentIndex });
  } catch (error) {
    return jsonError(error);
  }
}
