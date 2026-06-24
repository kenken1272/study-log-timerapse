import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { ensureUserProfile, listUserSessionMetadata } from "@/lib/gcp/userData";
import {
  createRecordedSession,
  toJsonSession,
} from "@/lib/sessions/firestore";
import { positiveNumber, readJsonRecord, speedValue } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    await ensureUserProfile(decodedToken);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "30");
    const cursor = url.searchParams.get("cursor");
    const result = await listUserSessionMetadata({
      uid: decodedToken.uid,
      limit: Number.isFinite(limit) ? limit : 30,
      cursor,
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    await ensureUserProfile(decodedToken);
    const body = await readJsonRecord(request);
    const targetStudyMinutes = positiveNumber(
      body.targetStudyMinutes,
      "targetStudyMinutes",
    );
    if (targetStudyMinutes > 720) {
      throw new Error("targetStudyMinutes must be 720 or less.");
    }
    const speed = body.speed === undefined ? 60 : speedValue(body.speed);
    const session = await createRecordedSession(decodedToken.uid, targetStudyMinutes, speed);

    return NextResponse.json({ session: toJsonSession(session) }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
