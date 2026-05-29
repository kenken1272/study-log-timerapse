import { NextResponse } from "next/server";
import {
  createRecordedSession,
  listSessions,
  toJsonSession,
} from "@/lib/sessions/firestore";
import { positiveNumber, readJsonRecord, speedValue } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions: sessions.map(toJsonSession) });
}

export async function POST(request: Request) {
  try {
    const body = await readJsonRecord(request);
    const targetStudyMinutes = positiveNumber(
      body.targetStudyMinutes,
      "targetStudyMinutes",
    );
    const speed = body.speed === undefined ? 60 : speedValue(body.speed);
    const session = await createRecordedSession(targetStudyMinutes, speed);

    return NextResponse.json({ session: toJsonSession(session) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
