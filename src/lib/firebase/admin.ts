import { Firestore } from "@google-cloud/firestore";
import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth, type DecodedIdToken } from "firebase-admin/auth";

let firestore: Firestore | null = null;
let adminApp: App | null = null;
let adminAuth: Auth | null = null;

export class FirebaseAuthError extends Error {
  status = 401;
}

export function getFirestoreDb(): Firestore {
  if (!firestore) {
    firestore = new Firestore({
      projectId: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
    });
  }

  return firestore;
}

function getFirebaseProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GCP_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT
  );
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function getFirebaseAdminApp(): App {
  if (adminApp) {
    return adminApp;
  }

  const [existingApp] = getApps();
  if (existingApp) {
    adminApp = existingApp;
    return adminApp;
  }

  const projectId = getFirebaseProjectId();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  adminApp = initializeApp({
    projectId,
    credential:
      clientEmail && privateKey
        ? cert({
            projectId,
            clientEmail,
            privateKey: normalizePrivateKey(privateKey),
          })
        : applicationDefault(),
  });

  return adminApp;
}

function getFirebaseAdminAuth(): Auth {
  if (!adminAuth) {
    adminAuth = getAuth(getFirebaseAdminApp());
  }

  return adminAuth;
}

export function getBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new FirebaseAuthError("Authorization: Bearer token is required.");
  }

  return token;
}

export async function verifyFirebaseIdToken(token: string): Promise<DecodedIdToken> {
  try {
    return await getFirebaseAdminAuth().verifyIdToken(token);
  } catch {
    throw new FirebaseAuthError("Invalid Firebase ID token.");
  }
}

export async function verifyFirebaseIdTokenFromRequest(
  request: Request,
): Promise<DecodedIdToken> {
  return verifyFirebaseIdToken(getBearerToken(request));
}
