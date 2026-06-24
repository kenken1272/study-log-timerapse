import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { listResumableSessions, toJsonSession } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const sessions = await listResumableSessions(decodedToken.uid);
    return NextResponse.json({ sessions: sessions.map(toJsonSession) });
  } catch (error) {
    return jsonError(error);
  }
}
