import { OAuth2Client } from "google-auth-library";

/**
 * Authenticating the Ubuntu worker's callback into Cloud Run.
 *
 * The worker holds no shared secret. It presents a Google-issued OIDC ID token
 * for its own service account, which is verified here against Google's public
 * keys. That means nothing long-lived has to be distributed to the lab host,
 * and a leaked token expires on its own.
 *
 * Two checks matter equally:
 *  - the audience must be this exact service URL, so a token minted for some
 *    other Google service cannot be replayed here;
 *  - the email must match the one service account we expect, so any other
 *    caller in the project — including one that legitimately holds a token for
 *    this audience — is still refused.
 */

const DEFAULT_WORKER_SERVICE_ACCOUNT =
  "study-timelapse-worker@vla-test1.iam.gserviceaccount.com";

let oauthClient: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!oauthClient) {
    oauthClient = new OAuth2Client();
  }

  return oauthClient;
}

export class WorkerAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "WorkerAuthError";
    this.status = status;
  }
}

export function getWorkerServiceAccountEmail(): string {
  return process.env.WORKER_SERVICE_ACCOUNT_EMAIL ?? DEFAULT_WORKER_SERVICE_ACCOUNT;
}

function getExpectedAudience(): string {
  const configured = process.env.WORKER_CALLBACK_AUDIENCE ?? process.env.CLOUD_RUN_SERVICE_URL;
  if (!configured) {
    throw new WorkerAuthError(
      "WORKER_CALLBACK_AUDIENCE is not configured.",
      500,
    );
  }

  return configured.replace(/\/$/, "");
}

/**
 * Verify the caller is the Ubuntu worker. Throws WorkerAuthError otherwise.
 */
export async function requireWorkerServiceAccount(request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new WorkerAuthError("Missing bearer token.");
  }

  const expectedAudience = getExpectedAudience();
  const expectedEmail = getWorkerServiceAccountEmail();

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: match[1],
      audience: expectedAudience,
    });
    payload = ticket.getPayload();
  } catch (error) {
    // Signature, expiry and audience failures all land here. The reason is not
    // echoed back to the caller — it would help someone probing the endpoint.
    const detail = error instanceof Error ? error.message : "unknown";
    console.warn(`[workerAuth] ID token rejected: ${detail}`);
    throw new WorkerAuthError("Invalid token.");
  }

  if (!payload) {
    throw new WorkerAuthError("Invalid token.");
  }

  // A token can be validly signed, unexpired and correctly addressed and still
  // belong to a different service account in the same project.
  if (payload.email !== expectedEmail) {
    console.warn(
      `[workerAuth] rejected caller ${payload.email ?? "(no email)"}; ` +
        `expected ${expectedEmail}`,
    );
    throw new WorkerAuthError("Caller is not authorised.", 403);
  }

  if (payload.email_verified === false) {
    throw new WorkerAuthError("Caller identity is not verified.", 403);
  }

  return payload.email;
}
