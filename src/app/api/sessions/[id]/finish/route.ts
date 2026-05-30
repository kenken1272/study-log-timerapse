import { NextResponse } from "next/server";
import { finishSession, getSession, toJsonSession } from "@/lib/sessions/firestore";
import {
  optionalString,
  qualityValue,
  readJsonRecord,
  requiredString,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await readJsonRecord(request);
    const existing = await getSession(id);
    if (!existing) {
      throw new Error("Session not found.");
    }
    if (existing.uploadStatus === "offline_pending" || existing.uploadStatus === "uploading") {
      throw new Error("未アップロードchunkがあります。アップロード完了後に終了してください。");
    }

    const session = await finishSession({
      sessionId: id,
      studyContent: requiredString(body.studyContent, "studyContent", 1000),
      quality: qualityValue(body.quality),
      reflectionNote: optionalString(body.reflectionNote, 5000),
    });

    return NextResponse.json({ session: toJsonSession(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
