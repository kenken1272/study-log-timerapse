import { NextResponse } from "next/server";
import { deleteSessionObjects } from "@/lib/gcp/storage";
import {
  deleteSessionDoc,
  getSession,
  toJsonSession,
  updateSessionReflection,
} from "@/lib/sessions/firestore";
import { optionalString, qualityValue, readJsonRecord } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json({ session: toJsonSession(session) });
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await readJsonRecord(request);
    const session = await updateSessionReflection({
      sessionId: id,
      studyContent: optionalString(body.studyContent, 1000),
      quality: body.quality === null || body.quality === undefined ? null : qualityValue(body.quality),
      reflectionNote: optionalString(body.reflectionNote, 5000),
    });

    return NextResponse.json({ session: toJsonSession(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    if (session.type === "recorded") {
      await deleteSessionObjects(id);
    }
    await deleteSessionDoc(id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
