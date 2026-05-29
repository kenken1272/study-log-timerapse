import { NextResponse } from "next/server";
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
    const body = await readJsonRecord(request);
    const session = await createOfflineSession({
      studyDate: requiredString(body.studyDate, "studyDate", 20),
      studyMinutes: positiveNumber(body.studyMinutes, "studyMinutes"),
      breakMinutes: nonNegativeNumber(body.breakMinutes ?? 0, "breakMinutes"),
      studyContent: requiredString(body.studyContent, "studyContent", 1000),
      quality: qualityValue(body.quality),
      reflectionNote: optionalString(body.reflectionNote, 5000),
    });

    return NextResponse.json({ session: toJsonSession(session) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
