import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";

const DEFAULT_SIGNING_SERVICE_ACCOUNT_EMAIL =
  "study-timelapse-sa@vla-test1.iam.gserviceaccount.com";
const SIGNED_URL_TTL_SEC = 150 * 60;

let storage: Storage | null = null;
let googleAuth: GoogleAuth | null = null;

export function getStorageClient(): Storage {
  if (!storage) {
    storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
    });
  }

  return storage;
}

function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) {
    googleAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }

  return googleAuth;
}

export function getBucketName(): string {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("GCS_BUCKET_NAME is not set.");
  }

  return bucketName;
}

function getSigningServiceAccountEmail(): string {
  return (
    process.env.SIGNING_SERVICE_ACCOUNT_EMAIL ??
    process.env.CLOUD_RUN_SERVICE_ACCOUNT_EMAIL ??
    DEFAULT_SIGNING_SERVICE_ACCOUNT_EMAIL
  );
}

export function getBucket() {
  return getStorageClient().bucket(getBucketName());
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 404
  );
}

export function userProfilePath(uid: string): string {
  return `users/${uid}/profile.json`;
}

export function userSessionPrefix(uid: string, sessionId: string): string {
  return `users/${uid}/sessions/${sessionId}/`;
}

export function userSessionMetadataPath(uid: string, sessionId: string): string {
  return `${userSessionPrefix(uid, sessionId)}metadata.json`;
}

export function userSessionTimelapsePath(uid: string, sessionId: string): string {
  return `${userSessionPrefix(uid, sessionId)}timelapse.mp4`;
}

export function userSessionThumbnailPath(uid: string, sessionId: string): string {
  return `${userSessionPrefix(uid, sessionId)}thumbnail.jpg`;
}

export function userSessionChunkPath(input: {
  uid: string;
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
}): string {
  return `${userSessionPrefix(input.uid, input.sessionId)}segments/${input.segmentIndex}/chunks/${input.chunkIndex}.webm`;
}

export async function downloadObjectToFile(
  objectPath: string,
  localPath: string,
): Promise<void> {
  await getBucket().file(objectPath).download({ destination: localPath });
}

export async function uploadFileToObject(
  localPath: string,
  objectPath: string,
  contentType: string,
): Promise<{ sizeBytes: number }> {
  const [file] = await getBucket().upload(localPath, {
    destination: objectPath,
    contentType,
    resumable: false,
  });
  const [metadata] = await file.getMetadata();
  const rawSize = metadata.size;
  const sizeBytes =
    typeof rawSize === "number"
      ? rawSize
      : typeof rawSize === "string"
        ? Number(rawSize)
        : 0;

  return { sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0 };
}

export async function uploadJsonToObject(
  objectPath: string,
  value: unknown,
): Promise<void> {
  await getBucket().file(objectPath).save(`${JSON.stringify(value, null, 2)}\n`, {
    contentType: "application/json",
    resumable: false,
  });
}

export async function downloadJsonFromObject<T>(objectPath: string): Promise<T | null> {
  try {
    const [buffer] = await getBucket().file(objectPath).download();
    return JSON.parse(buffer.toString("utf8")) as T;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

export async function listObjectPaths(input: {
  prefix: string;
  suffix?: string;
}): Promise<string[]> {
  const [files] = await getBucket().getFiles({ prefix: input.prefix });
  return files
    .map((file) => file.name)
    .filter((name) => (input.suffix ? name.endsWith(input.suffix) : true));
}

export async function deleteObjectIfExists(objectPath: string): Promise<boolean> {
  const file = getBucket().file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    return false;
  }

  await file.delete({ ignoreNotFound: true });
  return true;
}

export async function deleteObjects(
  objectPaths: string[],
): Promise<{ deletedCount: number; failed: Array<{ objectPath: string; message: string }> }> {
  const results = await Promise.all(
    objectPaths.map(async (objectPath) => {
      try {
        const deleted = await deleteObjectIfExists(objectPath);
        return { objectPath, deleted, message: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown delete error.";
        return { objectPath, deleted: false, message };
      }
    }),
  );
  const failed = results
    .filter((result) => result.message !== null)
    .map((result) => ({
      objectPath: result.objectPath,
      message: result.message ?? "Unknown delete error.",
    }));
  const deletedCount = results.filter((result) => result.deleted).length;

  return { deletedCount, failed };
}

export async function deleteSessionObjects(uid: string, sessionId: string): Promise<void> {
  await getBucket().deleteFiles({
    prefix: userSessionPrefix(uid, sessionId),
    force: true,
  });
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatDateParts(date: Date): { dateStamp: string; timestamp: string } {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  const seconds = `${date.getUTCSeconds()}`.padStart(2, "0");
  const dateStamp = `${year}${month}${day}`;

  return {
    dateStamp,
    timestamp: `${dateStamp}T${hours}${minutes}${seconds}Z`,
  };
}

function canonicalizeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

async function signWithIamCredentials(
  serviceAccountEmail: string,
  stringToSign: string,
): Promise<string> {
  const accessToken = await getGoogleAuth().getAccessToken();
  if (!accessToken) {
    throw new Error("Could not get Google Cloud access token for URL signing.");
  }

  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeRfc3986(
      serviceAccountEmail,
    )}:signBlob`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: Buffer.from(stringToSign, "utf8").toString("base64"),
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IAM signBlob failed: ${errorText}`);
  }

  const body = (await response.json()) as { signedBlob?: unknown };
  if (typeof body.signedBlob !== "string") {
    throw new Error("IAM signBlob response did not include signedBlob.");
  }

  return Buffer.from(body.signedBlob, "base64").toString("hex");
}

async function createV4SignedUrl(input: {
  method: "GET" | "PUT";
  objectPath: string;
}): Promise<string> {
  const bucketName = getBucketName();
  const serviceAccountEmail = getSigningServiceAccountEmail();
  const now = new Date();
  const { dateStamp, timestamp } = formatDateParts(now);
  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const canonicalUri = `/${encodeRfc3986(bucketName)}/${input.objectPath
    .split("/")
    .map(encodeRfc3986)
    .join("/")}`;
  const queryParams = {
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${serviceAccountEmail}/${credentialScope}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": `${SIGNED_URL_TTL_SEC}`,
    "X-Goog-SignedHeaders": "host",
  };
  const canonicalQuery = canonicalizeQuery(queryParams);
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    "host:storage.googleapis.com\n",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const canonicalRequestHash = createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");
  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");
  const signature = await signWithIamCredentials(serviceAccountEmail, stringToSign);

  return `https://storage.googleapis.com${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}

export async function createSignedUploadUrl(
  objectPath: string,
  contentType: string,
): Promise<string> {
  void contentType;

  return createV4SignedUrl({
    method: "PUT",
    objectPath,
  });
}

export async function createSignedReadUrl(objectPath: string): Promise<string> {
  return createV4SignedUrl({
    method: "GET",
    objectPath,
  });
}

export const getSignedReadUrl = createSignedReadUrl;
export const getSignedWriteUrl = createSignedUploadUrl;
