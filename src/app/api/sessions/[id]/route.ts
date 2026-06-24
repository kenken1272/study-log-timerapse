import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { deleteSessionObjects } from "@/lib/gcp/storage";
import { writeSessionMetadata } from "@/lib/gcp/userData";
import {
  deleteSessionDoc,
  getSessionForUser,
  toJsonSession,
  updateSessionReflection,
} from "@/lib/sessions/firestore";
import { optionalString, qualityValue, readJsonRecord } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    return NextResponse.json({ session: toJsonSession(session) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const existing = await getSessionForUser(id, decodedToken.uid);
    if (!existing) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    const body = await readJsonRecord(request);
    const session = await updateSessionReflection({
      sessionId: id,
      studyContent: optionalString(body.studyContent, 1000),
      quality: body.quality === null || body.quality === undefined ? null : qualityValue(body.quality),
      reflectionNote: optionalString(body.reflectionNote, 5000),
    });
    await writeSessionMetadata(session);

    return NextResponse.json({ session: toJsonSession(session) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    if (session.type === "recorded") {
      await deleteSessionObjects(decodedToken.uid, id);
    }
    await deleteSessionDoc(id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
