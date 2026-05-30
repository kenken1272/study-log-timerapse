import { NextResponse } from "next/server";
import { registerChunk, updateUploadStatus } from "@/lib/sessions/firestore";
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
    const { id } = await context.params;
    const body = await readJsonRecord(request);

    if (typeof body.objectPath === "string") {
      const segmentIndex =
        body.segmentIndex === undefined ? 0 : integerValue(body.segmentIndex, "segmentIndex");
      const chunkIndex =
        body.chunkIndex === undefined
          ? integerValue(body.index, "index")
          : integerValue(body.chunkIndex, "chunkIndex");
      await registerChunk({
        sessionId: id,
        segmentIndex,
        index: chunkIndex,
        objectPath: requiredString(body.objectPath, "objectPath", 1000),
        sizeBytes: nonNegativeNumber(body.sizeBytes, "sizeBytes"),
      });
    } else {
      await updateUploadStatus(id, uploadStatusValue(body.uploadStatus));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
