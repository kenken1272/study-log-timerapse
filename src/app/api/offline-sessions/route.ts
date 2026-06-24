import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { ensureUserProfile, writeSessionMetadata } from "@/lib/gcp/userData";
import { createOfflineSession, toJsonSession } from "@/lib/sessions/firestore";
import {
  nonNegativeNumber,
  optionalString,
  positiveNumber,
  qualityValue,
  readJsonRecord,
  requiredString,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    await ensureUserProfile(decodedToken);
    const body = await readJsonRecord(request);
    const session = await createOfflineSession({
      ownerUid: decodedToken.uid,
      studyDate: requiredString(body.studyDate, "studyDate", 20),
      studyMinutes: positiveNumber(body.studyMinutes, "studyMinutes"),
      breakMinutes: nonNegativeNumber(body.breakMinutes ?? 0, "breakMinutes"),
      studyContent: requiredString(body.studyContent, "studyContent", 1000),
      quality: qualityValue(body.quality),
      reflectionNote: optionalString(body.reflectionNote, 5000),
    });
    await writeSessionMetadata(session);

    return NextResponse.json({ session: toJsonSession(session) }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
