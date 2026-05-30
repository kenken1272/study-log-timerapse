import { NextResponse } from "next/server";
import { listResumableSessions, toJsonSession } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sessions = await listResumableSessions();
  return NextResponse.json({ sessions: sessions.map(toJsonSession) });
}
