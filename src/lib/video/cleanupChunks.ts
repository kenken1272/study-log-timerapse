import { deleteObjects } from "@/lib/gcp/storage";
import {
  getSession,
  updateSessionCleanupDeleting,
  updateSessionCleanupDone,
  updateSessionCleanupFailed,
} from "@/lib/sessions/firestore";

export type CleanupResult = {
  deletedCount: number;
  skipped: boolean;
  reason?: string;
};

/**
 * Delete a finished session's source chunks.
 *
 * Extracted from processTimelapse so it can run on a delay: the Ubuntu VLM
 * pipeline reads these same chunks, and deleting them the instant the
 * timelapse is built means an offline analysis worker can never catch up.
 * The user-visible timelapse behaviour is unchanged — only the moment of
 * deletion moved.
 */
export async function cleanupSessionChunks(sessionId: string): Promise<CleanupResult> {
  const session = await getSession(sessionId);
  if (!session) {
    return { deletedCount: 0, skipped: true, reason: "Session not found." };
  }

  // The timelapse is the artefact worth protecting. If it is not in place we
  // still hold the only copy of the source footage, so keep it.
  if (session.status !== "ready" || !session.timelapsePath) {
    return {
      deletedCount: 0,
      skipped: true,
      reason: `Session is ${session.status}; keeping chunks.`,
    };
  }

  if (session.cleanupStatus === "done") {
    return { deletedCount: 0, skipped: true, reason: "Already cleaned up." };
  }

  const pendingChunks = session.chunks.filter((chunk) => chunk.deletedAt === null);
  const chunksStorageBytes = session.chunks.reduce(
    (sum, chunk) => sum + chunk.sizeBytes,
    0,
  );

  if (pendingChunks.length === 0) {
    await updateSessionCleanupDone({
      sessionId,
      deletedObjectPaths: [],
      chunksStorageBytes,
    });
    return { deletedCount: 0, skipped: false };
  }

  const objectPaths = pendingChunks.map((chunk) => chunk.objectPath);
  await updateSessionCleanupDeleting(sessionId);
  const result = await deleteObjects(objectPaths);

  if (result.failed.length > 0) {
    await updateSessionCleanupFailed(
      sessionId,
      result.failed
        .map((failure) => `${failure.objectPath}: ${failure.message}`)
        .join("\n"),
    );
    return { deletedCount: result.deletedCount, skipped: false };
  }

  await updateSessionCleanupDone({
    sessionId,
    deletedObjectPaths: objectPaths,
    chunksStorageBytes,
  });

  return { deletedCount: result.deletedCount, skipped: false };
}
