import { after, NextResponse } from "next/server";
import {
  getSession,
  toJsonSession,
  updateSessionProcessing,
} from "@/lib/sessions/firestore";
import { processTimelapse } from "@/lib/video/processTimelapse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (session.status === "processing") {
      return NextResponse.json(
        { ok: true, session: toJsonSession(session) },
        { status: 202 },
      );
    }

    await updateSessionProcessing(id);
    after(async () => {
      await processTimelapse(id).catch(() => undefined);
    });

    const updated = await getSession(id);
    return NextResponse.json(
      { ok: true, session: updated ? toJsonSession(updated) : null },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
