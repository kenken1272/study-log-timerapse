import { NextResponse } from "next/server";
import { interruptSession } from "@/lib/sessions/firestore";
import { readJsonRecord } from "@/lib/validation";
import type { InterruptionReason, UploadStatus } from "@/lib/sessions/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function reasonValue(value: unknown): InterruptionReason {
  if (
    value === "network_offline" ||
    value === "tab_closed" ||
    value === "browser_crash" ||
    value === "manual_pause" ||
    value === "unknown"
  ) {
    return value;
  }

  return "unknown";
}

function uploadStatusValue(value: unknown): UploadStatus | undefined {
  if (
    value === "idle" ||
    value === "uploading" ||
    value === "offline_pending" ||
    value === "uploaded" ||
    value === "failed"
  ) {
    return value;
  }

  return undefined;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await readJsonRecord(request);
    await interruptSession({
      sessionId: id,
      reason: reasonValue(body.reason),
      uploadStatus: uploadStatusValue(body.uploadStatus),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
