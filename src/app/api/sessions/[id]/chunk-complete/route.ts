import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { userSessionChunkPath } from "@/lib/gcp/storage";
import { getSessionForUser, registerChunk } from "@/lib/sessions/firestore";
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
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    const body = await readJsonRecord(request);
    const segmentIndex =
      body.segmentIndex === undefined ? 0 : integerValue(body.segmentIndex, "segmentIndex");
    const chunkIndex =
      body.chunkIndex === undefined
        ? integerValue(body.index, "index")
        : integerValue(body.chunkIndex, "chunkIndex");
    const expectedObjectPath = userSessionChunkPath({
      uid: decodedToken.uid,
      sessionId: id,
      segmentIndex,
      chunkIndex,
    });
    const objectPath = requiredString(body.objectPath, "objectPath", 1000);
    if (objectPath !== expectedObjectPath) {
      throw new Error("objectPath does not match the authenticated user.");
    }
    await registerChunk({
      sessionId: id,
      segmentIndex,
      index: chunkIndex,
      objectPath,
      sizeBytes: nonNegativeNumber(body.sizeBytes, "sizeBytes"),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
