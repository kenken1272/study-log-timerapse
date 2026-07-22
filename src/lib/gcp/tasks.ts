import { GoogleAuth } from "google-auth-library";

const DEFAULT_QUEUE = "timelapse-processing";
const DEFAULT_LOCATION = "asia-northeast1";
const DEFAULT_SERVICE_URL =
  "https://study-timelapse-116342725707.asia-northeast1.run.app";
const DISPATCH_DEADLINE_SECONDS = 30 * 60;
// Recovery window for the Ubuntu VLM pipeline before source chunks are removed.
const DEFAULT_CHUNK_CLEANUP_DELAY_SECONDS = 24 * 60 * 60;
const MAX_SCHEDULE_AHEAD_SECONDS = 30 * 24 * 60 * 60;

let googleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) {
    googleAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }

  return googleAuth;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }

  return value;
}

function getProjectId(): string {
  return (
    process.env.GCP_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.FIREBASE_PROJECT_ID ??
    requiredEnv("GCP_PROJECT_ID")
  );
}

function getServiceUrl(): string {
  return (process.env.CLOUD_RUN_SERVICE_URL ?? DEFAULT_SERVICE_URL).replace(/\/$/, "");
}

async function enqueueTask(input: {
  path: string;
  payload: Record<string, unknown>;
  scheduleTime?: Date;
}): Promise<string> {
  const projectId = getProjectId();
  const location = process.env.CLOUD_TASKS_LOCATION ?? DEFAULT_LOCATION;
  const queue = process.env.CLOUD_TASKS_QUEUE ?? DEFAULT_QUEUE;
  const parent = `projects/${projectId}/locations/${location}/queues/${queue}`;
  const url = `${getServiceUrl()}${input.path}`;
  const secret = requiredEnv("INTERNAL_PROCESS_SECRET");
  const body = Buffer.from(JSON.stringify(input.payload), "utf8").toString("base64");
  const accessToken = await getGoogleAuth().getAccessToken();
  if (!accessToken) {
    throw new Error("Could not get Google Cloud access token for Cloud Tasks.");
  }

  const response = await fetch(
    `https://cloudtasks.googleapis.com/v2/${encodeURIComponent(
      parent,
    ).replaceAll("%2F", "/")}/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: {
          dispatchDeadline: `${DISPATCH_DEADLINE_SECONDS}s`,
          ...(input.scheduleTime
            ? { scheduleTime: input.scheduleTime.toISOString() }
            : {}),
          httpRequest: {
            httpMethod: "POST",
            url,
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": secret,
            },
            body,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloud Tasks enqueue failed: ${errorText}`);
  }

  const task = (await response.json()) as { name?: string };
  return task.name ?? "";
}

export async function enqueueTimelapseProcessingTask(sessionId: string): Promise<string> {
  return enqueueTask({
    path: `/api/sessions/${encodeURIComponent(sessionId)}/do-process`,
    payload: { sessionId, source: "cloud-tasks" },
  });
}

/**
 * Which host renders timelapses.
 *
 * "ubuntu" moves FFmpeg off Cloud Run onto the lab GPU box, which is the point
 * of the change — Cloud Run was billing CPU-seconds for a decode-bound job that
 * takes ~62s for a three-hour session. "cloudrun" keeps the original path and
 * is the rollback.
 */
export type TimelapseBackend = "cloudrun" | "ubuntu";

export function getTimelapseBackend(): TimelapseBackend {
  return process.env.TIMELAPSE_BACKEND === "ubuntu" ? "ubuntu" : "cloudrun";
}

export function getChunkCleanupDelaySeconds(): number {
  const raw = Number(process.env.CHUNK_CLEANUP_DELAY_SEC);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CHUNK_CLEANUP_DELAY_SECONDS;
  }

  // Cloud Tasks refuses a schedule more than 30 days out.
  return Math.min(raw, MAX_SCHEDULE_AHEAD_SECONDS);
}

/**
 * Schedule source-chunk deletion instead of doing it inline.
 *
 * The delay is the recovery window for the Ubuntu VLM pipeline: if that host is
 * offline when a session finishes, Pub/Sub still holds the events and the
 * chunks are still there when it comes back.
 */
export async function enqueueChunkCleanupTask(
  sessionId: string,
  delaySeconds = getChunkCleanupDelaySeconds(),
): Promise<string> {
  return enqueueTask({
    path: `/api/sessions/${encodeURIComponent(sessionId)}/cleanup-chunks`,
    payload: { sessionId, source: "cloud-tasks" },
    scheduleTime: new Date(Date.now() + delaySeconds * 1000),
  });
}
