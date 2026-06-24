import { GoogleAuth } from "google-auth-library";

const DEFAULT_QUEUE = "timelapse-processing";
const DEFAULT_LOCATION = "asia-northeast1";
const DEFAULT_SERVICE_URL =
  "https://study-timelapse-116342725707.asia-northeast1.run.app";
const DISPATCH_DEADLINE_SECONDS = 30 * 60;

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

export async function enqueueTimelapseProcessingTask(sessionId: string): Promise<string> {
  const projectId = getProjectId();
  const location = process.env.CLOUD_TASKS_LOCATION ?? DEFAULT_LOCATION;
  const queue = process.env.CLOUD_TASKS_QUEUE ?? DEFAULT_QUEUE;
  const parent = `projects/${projectId}/locations/${location}/queues/${queue}`;
  const url = `${getServiceUrl()}/api/sessions/${encodeURIComponent(sessionId)}/do-process`;
  const secret = requiredEnv("INTERNAL_PROCESS_SECRET");
  const body = Buffer.from(
    JSON.stringify({ sessionId, source: "cloud-tasks" }),
    "utf8",
  ).toString("base64");
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
