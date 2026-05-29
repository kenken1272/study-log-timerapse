import { NextResponse } from "next/server";
import { registerChunk } from "@/lib/sessions/firestore";
import {
  integerValue,
  nonNegativeNumber,
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
    await registerChunk({
      sessionId: id,
      index: integerValue(body.index, "index"),
      objectPath: requiredString(body.objectPath, "objectPath", 1000),
      sizeBytes: nonNegativeNumber(body.sizeBytes, "sizeBytes"),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
