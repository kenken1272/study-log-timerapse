import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { enqueueTimelapseProcessingTask } from "@/lib/gcp/tasks";
import { writeSessionMetadata } from "@/lib/gcp/userData";
import {
  finishSession,
  getSessionForUser,
  toJsonSession,
  updateSessionFailed,
  updateSessionProcessing,
} from "@/lib/sessions/firestore";
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
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const body = await readJsonRecord(request);
    const existing = await getSessionForUser(id, decodedToken.uid);
    if (!existing) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
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
    await writeSessionMetadata(session);
    if (session.type === "recorded") {
      await updateSessionProcessing(id);
      try {
        await enqueueTimelapseProcessingTask(id);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "タイムラプス生成を開始できませんでした。";
        await updateSessionFailed(id, message);
        throw error;
      }
    }

    const updated = await getSessionForUser(id, decodedToken.uid);
    return NextResponse.json({ session: toJsonSession(updated ?? session) });
  } catch (error) {
    return jsonError(error);
  }
}
