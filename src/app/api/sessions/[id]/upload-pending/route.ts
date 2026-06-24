import { NextResponse } from "next/server";
import { jsonError, requireAuthenticatedUser } from "@/lib/api/auth";
import { userSessionChunkPath } from "@/lib/gcp/storage";
import {
  getSessionForUser,
  registerChunk,
  updateUploadStatus,
} from "@/lib/sessions/firestore";
import {
  integerValue,
  nonNegativeNumber,
  readJsonRecord,
  requiredString,
} from "@/lib/validation";
import type { UploadStatus } from "@/lib/sessions/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function uploadStatusValue(value: unknown): UploadStatus {
  if (
    value === "idle" ||
    value === "uploading" ||
    value === "offline_pending" ||
    value === "uploaded" ||
    value === "failed"
  ) {
    return value;
  }

  return "offline_pending";
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const decodedToken = await requireAuthenticatedUser(request);
    const { id } = await context.params;
    const session = await getSessionForUser(id, decodedToken.uid);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    const body = await readJsonRecord(request);

    if (typeof body.objectPath === "string") {
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
    } else {
      await updateUploadStatus(id, uploadStatusValue(body.uploadStatus));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
