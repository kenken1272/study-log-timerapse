import { NextResponse } from "next/server";
import { WorkerAuthError, requireWorkerServiceAccount } from "@/lib/api/workerAuth";
import { enqueueChunkCleanupTask, getChunkCleanupDelaySeconds } from "@/lib/gcp/tasks";
import {
  getBucket,
  userSessionThumbnailPath,
  userSessionTimelapsePath,
} from "@/lib/gcp/storage";
import { writeSessionMetadata } from "@/lib/gcp/userData";
import { getSession, updateSessionReady } from "@/lib/sessions/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

type CompletePayload = {
  uid?: unknown;
  sourceFingerprint?: unknown;
  timelapsePath?: unknown;
  thumbnailPath?: unknown;
  timelapseGeneration?: unknown;
  thumbnailGeneration?: unknown;
  sizeBytes?: unknown;
  durationSec?: unknown;
  encoder?: unknown;
  fallbackUsed?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Called by the Ubuntu worker once a timelapse has been rendered, validated and
 * uploaded. This is the only way rendering on another host can move a session
 * to `ready`, so it re-derives everything rather than trusting the payload.
 *
 * Specifically: the object paths are rebuilt from the verified uid and session
 * id rather than taken from the request, and the objects are inspected in GCS
 * before Firestore is touched. A caller who reached this endpoint with a valid
 * worker token still cannot point a session at someone else's file, or mark a
 * session ready for a video that was never uploaded.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    await requireWorkerServiceAccount(request);
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as CompletePayload;
    const uid = asString(body.uid);
    const fingerprint = asString(body.sourceFingerprint);
    if (!uid || !fingerprint) {
      return NextResponse.json(
        { error: "uid and sourceFingerprint are required." },
        { status: 400 },
      );
    }

    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    // The worker does not get to say who owns a session.
    if (session.ownerUid !== uid) {
      console.warn(
        `[timelapse-complete] uid mismatch for ${id}: payload ${uid}, session ${session.ownerUid}`,
      );
      return NextResponse.json({ error: "Session does not match uid." }, { status: 403 });
    }

    // Paths are derived, never accepted. Anything the caller sent is only used
    // to detect a disagreement worth logging.
    const timelapsePath = userSessionTimelapsePath(uid, id);
    const thumbnailPath = userSessionThumbnailPath(uid, id);
    const claimedTimelapse = asString(body.timelapsePath);
    if (claimedTimelapse && claimedTimelapse !== timelapsePath) {
      console.warn(
        `[timelapse-complete] ignoring supplied path ${claimedTimelapse}; using ${timelapsePath}`,
      );
    }

    // Already done with this exact source? Report success without redoing work
    // or re-scheduling cleanup — the worker retries callbacks.
    if (
      session.status === "ready" &&
      session.timelapsePath === timelapsePath &&
      asString(session.timelapseFingerprint) === fingerprint
    ) {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }

    const bucket = getBucket();
    const [videoFile, thumbFile] = [bucket.file(timelapsePath), bucket.file(thumbnailPath)];
    const [videoExists] = await videoFile.exists();
    if (!videoExists) {
      return NextResponse.json(
        { error: `Timelapse object is not present at ${timelapsePath}.` },
        { status: 409 },
      );
    }

    const [videoMetadata] = await videoFile.getMetadata();
    const sizeBytes = Number(videoMetadata.size ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return NextResponse.json({ error: "Timelapse object is empty." }, { status: 409 });
    }
    if (videoMetadata.contentType !== "video/mp4") {
      return NextResponse.json(
        { error: `Unexpected content type ${videoMetadata.contentType}.` },
        { status: 409 },
      );
    }

    const claimedGeneration = asString(body.timelapseGeneration);
    if (claimedGeneration && String(videoMetadata.generation) !== claimedGeneration) {
      // A newer render landed after this callback was sent. The stale one must
      // not overwrite the fresher result.
      console.warn(
        `[timelapse-complete] stale callback for ${id}: reported generation ` +
          `${claimedGeneration}, GCS holds ${videoMetadata.generation}`,
      );
      return NextResponse.json(
        { ok: true, stale: true, message: "Superseded by a newer render." },
        { status: 200 },
      );
    }

    const [thumbExists] = await thumbFile.exists();
    const resolvedThumbnail = thumbExists ? thumbnailPath : null;
    if (!thumbExists) {
      console.warn(`[timelapse-complete] no thumbnail at ${thumbnailPath} for ${id}`);
    }

    await updateSessionReady(id, timelapsePath, sizeBytes, resolvedThumbnail, fingerprint);

    const readySession = await getSession(id);
    if (readySession) {
      await writeSessionMetadata(readySession);
    }

    // Cleanup is scheduled here rather than in the renderer, because this is
    // the first point at which both the video and the session record are known
    // good. Chunks are the only copy of the source, so the 24h delay stays.
    let cleanupTask: string | null = null;
    try {
      const delaySeconds = getChunkCleanupDelaySeconds();
      cleanupTask = await enqueueChunkCleanupTask(id, delaySeconds);
      console.log(
        `[timelapse-complete] ${id} ready (${sizeBytes} bytes, encoder=` +
          `${asString(body.encoder) || "unknown"}); cleanup in ${delaySeconds}s`,
      );
    } catch (cleanupError) {
      // Chunks staying longer costs storage; losing them costs the recording.
      const message =
        cleanupError instanceof Error ? cleanupError.message : "unknown error";
      console.error(`[timelapse-complete] cleanup scheduling failed for ${id}: ${message}`);
    }

    return NextResponse.json(
      { ok: true, timelapsePath, thumbnailPath: resolvedThumbnail, sizeBytes, cleanupTask },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error(`[timelapse-complete] ${id} failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
