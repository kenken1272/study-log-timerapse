import type { DecodedIdToken } from "firebase-admin/auth";
import {
  downloadJsonFromObject,
  listObjectPaths,
  uploadJsonToObject,
  userProfilePath,
  userSessionMetadataPath,
} from "@/lib/gcp/storage";
import type { JsonStudySession, StudySession } from "@/lib/sessions/types";
import { toJsonSession } from "@/lib/sessions/firestore";

export const DEFAULT_WEEKLY_GOAL_HOURS = 10;

export type UserProfile = {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  weeklyGoalHours: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionMetadata = {
  sessionId: string;
  title: string;
  note: string;
  targetMinutes: number | null;
  durationMinutes: number;
  thumbnailPath: string | null;
  timelapsePath: string | null;
  createdAt: string;
  updatedAt: string;
  session: JsonStudySession;
};

function tokenStringClaim(decodedToken: DecodedIdToken, key: string): string {
  const value = decodedToken[key];
  return typeof value === "string" ? value : "";
}

function normalizeWeeklyGoalHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WEEKLY_GOAL_HOURS;
  }

  return Math.round(value * 100) / 100;
}

export async function ensureUserProfile(
  decodedToken: DecodedIdToken,
  input: { weeklyGoalHours?: number } = {},
): Promise<UserProfile> {
  const path = userProfilePath(decodedToken.uid);
  const existing = await downloadJsonFromObject<Partial<UserProfile>>(path);
  const now = new Date().toISOString();
  const weeklyGoalHours =
    input.weeklyGoalHours ??
    (typeof existing?.weeklyGoalHours === "number"
      ? existing.weeklyGoalHours
      : DEFAULT_WEEKLY_GOAL_HOURS);
  const profile: UserProfile = {
    uid: decodedToken.uid,
    name: tokenStringClaim(decodedToken, "name"),
    email: tokenStringClaim(decodedToken, "email"),
    photoURL: tokenStringClaim(decodedToken, "picture"),
    weeklyGoalHours: normalizeWeeklyGoalHours(weeklyGoalHours),
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now,
  };

  await uploadJsonToObject(path, profile);
  return profile;
}

export async function updateUserWeeklyGoalHours(
  decodedToken: DecodedIdToken,
  weeklyGoalHours: number,
): Promise<UserProfile> {
  return ensureUserProfile(decodedToken, {
    weeklyGoalHours: normalizeWeeklyGoalHours(weeklyGoalHours),
  });
}

export async function writeSessionMetadata(session: StudySession): Promise<SessionMetadata> {
  const jsonSession = toJsonSession(session);
  const metadata: SessionMetadata = {
    sessionId: session.id,
    title: session.studyContent ?? "録画セッション",
    note: session.reflectionNote ?? "",
    targetMinutes: session.targetStudyMinutes,
    durationMinutes: Math.round(session.actualStudySec / 60),
    thumbnailPath: session.thumbnailPath,
    timelapsePath: session.timelapsePath,
    createdAt: jsonSession.createdAt,
    updatedAt: jsonSession.updatedAt,
    session: jsonSession,
  };
  const path = userSessionMetadataPath(session.ownerUid, session.id);
  await uploadJsonToObject(path, metadata);
  console.log(`Saved metadata: ${path}`);

  return metadata;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export async function listUserSessionMetadata(input: {
  uid: string;
  limit: number;
  cursor: string | null;
}): Promise<{ sessions: JsonStudySession[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit)));
  const paths = await listObjectPaths({
    prefix: `users/${input.uid}/sessions/`,
    suffix: "/metadata.json",
  });
  const metadata = await Promise.all(
    paths.map(async (path) => {
      try {
        return await downloadJsonFromObject<SessionMetadata>(path);
      } catch {
        return null;
      }
    }),
  );
  const sessions = metadata
    .map((item) => item?.session)
    .filter((session): session is JsonStudySession => Boolean(session))
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  const offset = decodeCursor(input.cursor);
  const nextOffset = offset + limit;
  const page = sessions.slice(offset, nextOffset);

  return {
    sessions: page,
    nextCursor: nextOffset < sessions.length ? encodeCursor(nextOffset) : null,
  };
}
