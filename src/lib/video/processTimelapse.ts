import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deleteObjects,
  downloadObjectToFile,
  uploadFileToObject,
  userSessionThumbnailPath,
  userSessionTimelapsePath,
} from "@/lib/gcp/storage";
import { writeSessionMetadata } from "@/lib/gcp/userData";
import {
  getSession,
  getAutoTimelapseSpeed,
  updateSessionCleanupDeleting,
  updateSessionCleanupDone,
  updateSessionCleanupFailed,
  updateSessionFailed,
  updateSessionProcessing,
  updateSessionReady,
} from "@/lib/sessions/firestore";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.slice(-4000) || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

export async function processTimelapse(sessionId: string): Promise<string> {
  await updateSessionProcessing(sessionId);

  try {
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error("Session not found.");
    }
    if (session.type !== "recorded") {
      throw new Error("Only recorded sessions can be processed.");
    }
    if (session.chunks.length === 0) {
      throw new Error("No chunks uploaded.");
    }

    const speed = session.speed ?? getAutoTimelapseSpeed(session.actualStudySec);
    const workDir = path.join("/tmp", sessionId);
    const chunksDir = path.join(workDir, "chunks");
    await rm(workDir, { recursive: true, force: true });
    await mkdir(chunksDir, { recursive: true });

    const sortedChunks = [...session.chunks].sort(
      (a, b) => a.segmentIndex - b.segmentIndex || a.index - b.index,
    );
    const localFiles: string[] = [];

    for (const chunk of sortedChunks) {
      const localPath = path.join(chunksDir, `${chunk.segmentIndex}-${chunk.index}.mp4`);
      await downloadObjectToFile(chunk.objectPath, localPath);
      localFiles.push(localPath);
    }

    const filesTxt = path.join(workDir, "files.txt");
    await writeFile(
      filesTxt,
      localFiles.map((file) => `file ${shellQuote(file)}`).join("\n"),
      "utf8",
    );

    const outputPath = path.join(workDir, "timelapse.mp4");
    const thumbnailLocalPath = path.join(workDir, "thumbnail.jpg");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      filesTxt,
      "-filter:v",
      `setpts=PTS/${speed},fps=30,scale=1280:-2`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      outputPath,
    ]);
    await runFfmpeg([
      "-y",
      "-ss",
      "0",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:-2",
      "-q:v",
      "3",
      thumbnailLocalPath,
    ]);

    const timelapsePath = userSessionTimelapsePath(session.ownerUid, sessionId);
    const thumbnailPath = userSessionThumbnailPath(session.ownerUid, sessionId);
    const timelapseUpload = await uploadFileToObject(
      outputPath,
      timelapsePath,
      "video/mp4",
    );
    await uploadFileToObject(thumbnailLocalPath, thumbnailPath, "image/jpeg");
    console.log(`Saved timelapse: ${timelapsePath}`);
    console.log(`Saved thumbnail: ${thumbnailPath}`);
    await updateSessionReady(
      sessionId,
      timelapsePath,
      timelapseUpload.sizeBytes,
      thumbnailPath,
    );

    try {
      const chunkObjectPaths = sortedChunks
        .filter((chunk) => chunk.deletedAt === null)
        .map((chunk) => chunk.objectPath);
      const chunksStorageBytes = sortedChunks.reduce(
        (sum, chunk) => sum + chunk.sizeBytes,
        0,
      );
      if (chunkObjectPaths.length > 0) {
        await updateSessionCleanupDeleting(sessionId);
        const deleteResult = await deleteObjects(chunkObjectPaths);
        if (deleteResult.failed.length > 0) {
          await updateSessionCleanupFailed(
            sessionId,
            deleteResult.failed
              .map((failure) => `${failure.objectPath}: ${failure.message}`)
              .join("\n"),
          );
        } else {
          await updateSessionCleanupDone({
            sessionId,
            deletedObjectPaths: chunkObjectPaths,
            chunksStorageBytes,
          });
        }
      } else {
        await updateSessionCleanupDone({
          sessionId,
          deletedObjectPaths: [],
          chunksStorageBytes,
        });
      }
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error.";
      await updateSessionCleanupFailed(sessionId, cleanupMessage);
    }
    const finalSession = await getSession(sessionId);
    if (finalSession) {
      await writeSessionMetadata(finalSession);
    }
    await rm(workDir, { recursive: true, force: true });

    return timelapsePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown timelapse error.";
    await updateSessionFailed(sessionId, message);
    throw error;
  }
}
