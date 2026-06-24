import { NextResponse } from "next/server";
import type { DecodedIdToken } from "firebase-admin/auth";
import {
  FirebaseAuthError,
  verifyFirebaseIdTokenFromRequest,
} from "@/lib/firebase/admin";

export async function requireAuthenticatedUser(request: Request): Promise<DecodedIdToken> {
  return verifyFirebaseIdTokenFromRequest(request);
}

export function jsonError(error: unknown, fallbackStatus = 400): NextResponse {
  const message = error instanceof Error ? error.message : "Invalid request.";
  const status = error instanceof FirebaseAuthError ? error.status : fallbackStatus;
  return NextResponse.json({ error: message }, { status });
}
