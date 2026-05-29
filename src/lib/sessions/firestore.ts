import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { getFirestoreDb } from "@/lib/firebase/admin";
import type {
  BreakLog,
  JsonBreakLog,
  JsonSessionChunk,
  JsonStudySession,
  StudyQuality,
  StudySession,
  TimelapseSpeed,
} from "@/lib/sessions/types";

const SESSIONS_COLLECTION = "sessions";
const SETTINGS_COLLECTION = "settings";
const WEEKLY_GOAL_DOC = "weeklyGoal";

export function getAutoTimelapseSpeed(actualStudySec: number): TimelapseSpeed {
  if (actualStudySec < 45 * 60) {
    return 30;
  }
  if (actualStudySec < 120 * 60) {
    return 60;
  }

  return 120;
}

function sessionCollection() {
  return getFirestoreDb().collection(SESSIONS_COLLECTION);
}

function timestampToIso(value: Timestamp | null): string | null {
  return value ? value.toDate().toISOString() : null;
}

export function toJsonSession(session: StudySession): JsonStudySession {
  const chunks: JsonSessionChunk[] = session.chunks.map((chunk) => ({
    ...chunk,
    uploadedAt: chunk.uploadedAt.toDate().toISOString(),
  }));
  const breakLogs: JsonBreakLog[] = session.breakLogs.map((breakLog) => ({
    ...breakLog,
    startedAt: breakLog.startedAt.toDate().toISOString(),
    endedAt: timestampToIso(breakLog.endedAt),
  }));

  return {
    ...session,
    startedAt: session.startedAt.toDate().toISOString(),
    endedAt: timestampToIso(session.endedAt),
    createdAt: session.createdAt.toDate().toISOString(),
    updatedAt: session.updatedAt.toDate().toISOString(),
    chunks,
    breakLogs,
  };
}

function snapshotToSession(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): StudySession | null {
  const data = snapshot.data() as Omit<StudySession, "id"> | undefined;
  if (!data) {
    return null;
  }

  return {
    ...data,
    id: snapshot.id,
    chunks: data.chunks ?? [],
    breakLogs: data.breakLogs ?? [],
    thumbnailPath: data.thumbnailPath ?? null,
  };
}

export async function listSessions(limit = 50): Promise<StudySession[]> {
  const snapshot = await sessionCollection()
    .orderBy("startedAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs
    .map((doc) => snapshotToSession(doc))
    .filter((session): session is StudySession => session !== null);
}

export async function listAllSessions(): Promise<StudySession[]> {
  const snapshot = await sessionCollection().orderBy("startedAt", "desc").get();

  return snapshot.docs
    .map((doc) => snapshotToSession(doc))
    .filter((session): session is StudySession => session !== null);
}

export async function getSession(id: string): Promise<StudySession | null> {
  const snapshot = await sessionCollection().doc(id).get();
  return snapshotToSession(snapshot);
}

export async function createRecordedSession(
  targetStudyMinutes: number,
  speed: TimelapseSpeed,
): Promise<StudySession> {
  const doc = sessionCollection().doc();
  const now = Timestamp.now();
  const session: StudySession = {
    id: doc.id,
    type: "recorded",
    targetStudyMinutes,
    targetStudySec: Math.round(targetStudyMinutes * 60),
    actualStudySec: 0,
    totalElapsedSec: null,
    totalBreakSec: 0,
    achievementRate: null,
    speed,
    status: "recording",
    startedAt: now,
    endedAt: null,
    chunkCount: 0,
    chunks: [],
    breakLogs: [],
    studyContent: null,
    quality: null,
    reflectionNote: null,
    timelapsePath: null,
    thumbnailPath: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };

  await doc.set(session);
  return session;
}

export async function createOfflineSession(input: {
  studyDate: string;
  studyMinutes: number;
  breakMinutes: number;
  studyContent: string;
  quality: StudyQuality;
  reflectionNote: string | null;
}): Promise<StudySession> {
  const doc = sessionCollection().doc();
  const now = Timestamp.now();
  const startedAt = Timestamp.fromDate(new Date(`${input.studyDate}T00:00:00+09:00`));
  const actualStudySec = Math.round(input.studyMinutes * 60);
  const totalBreakSec = Math.round(input.breakMinutes * 60);
  const session: StudySession = {
    id: doc.id,
    type: "offline",
    targetStudyMinutes: null,
    targetStudySec: null,
    actualStudySec,
    totalElapsedSec: actualStudySec + totalBreakSec,
    totalBreakSec,
    achievementRate: null,
    speed: null,
    status: "ready",
    startedAt,
    endedAt: startedAt,
    chunkCount: 0,
    chunks: [],
    breakLogs: [],
    studyContent: input.studyContent,
    quality: input.quality,
    reflectionNote: input.reflectionNote,
    timelapsePath: null,
    thumbnailPath: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };

  await doc.set(session);
  return session;
}

export async function registerChunk(input: {
  sessionId: string;
  index: number;
  objectPath: string;
  sizeBytes: number;
}): Promise<void> {
  const ref = sessionCollection().doc(input.sessionId);
  await getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }

    const chunk = {
      index: input.index,
      objectPath: input.objectPath,
      sizeBytes: input.sizeBytes,
      uploadedAt: Timestamp.now(),
    };
    const chunks = [...session.chunks.filter((item) => item.index !== input.index), chunk].sort(
      (a, b) => a.index - b.index,
    );

    transaction.update(ref, {
      chunks,
      chunkCount: chunks.length,
      updatedAt: Timestamp.now(),
    });
  });
}

export async function startBreak(sessionId: string): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    breakLogs: FieldValue.arrayUnion({
      startedAt: Timestamp.now(),
      endedAt: null,
      durationSec: null,
    }),
    updatedAt: Timestamp.now(),
  });
}

export async function endBreak(sessionId: string): Promise<void> {
  const ref = sessionCollection().doc(sessionId);
  await getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }

    const now = Timestamp.now();
    let closed = false;
    const breakLogs = session.breakLogs.map((breakLog) => {
      if (!closed && breakLog.endedAt === null) {
        closed = true;
        return {
          ...breakLog,
          endedAt: now,
          durationSec: Math.max(
            0,
            Math.round((now.toMillis() - breakLog.startedAt.toMillis()) / 1000),
          ),
        };
      }

      return breakLog;
    });

    if (!closed) {
      throw new Error("No active break found.");
    }

    transaction.update(ref, {
      breakLogs,
      updatedAt: now,
    });
  });
}

function closeOpenBreaks(breakLogs: BreakLog[], endedAt: Timestamp): BreakLog[] {
  return breakLogs.map((breakLog) => {
    if (breakLog.endedAt !== null) {
      return breakLog;
    }

    return {
      ...breakLog,
      endedAt,
      durationSec: Math.max(
        0,
        Math.round((endedAt.toMillis() - breakLog.startedAt.toMillis()) / 1000),
      ),
    };
  });
}

export async function finishSession(input: {
  sessionId: string;
  studyContent: string;
  quality: StudyQuality;
  reflectionNote: string | null;
}): Promise<StudySession> {
  const ref = sessionCollection().doc(input.sessionId);
  return getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }

    const endedAt = Timestamp.now();
    const breakLogs = closeOpenBreaks(session.breakLogs, endedAt);
    const totalElapsedSec = Math.max(
      0,
      Math.round((endedAt.toMillis() - session.startedAt.toMillis()) / 1000),
    );
    const totalBreakSec = breakLogs.reduce(
      (sum, breakLog) => sum + (breakLog.durationSec ?? 0),
      0,
    );
    const actualStudySec = Math.max(0, totalElapsedSec - totalBreakSec);
    const achievementRate =
      session.targetStudySec && session.targetStudySec > 0
        ? Math.min(999, (actualStudySec / session.targetStudySec) * 100)
        : null;
    const speed =
      session.type === "recorded" ? getAutoTimelapseSpeed(actualStudySec) : null;
    const updatedSession: StudySession = {
      ...session,
      status: "uploaded",
      endedAt,
      totalElapsedSec,
      totalBreakSec,
      actualStudySec,
      achievementRate,
      speed,
      breakLogs,
      studyContent: input.studyContent,
      quality: input.quality,
      reflectionNote: input.reflectionNote,
      updatedAt: endedAt,
    };

    transaction.update(ref, updatedSession);
    return updatedSession;
  });
}

export async function updateSessionReflection(input: {
  sessionId: string;
  studyContent: string | null;
  quality: StudyQuality | null;
  reflectionNote: string | null;
}): Promise<StudySession> {
  const ref = sessionCollection().doc(input.sessionId);
  const now = Timestamp.now();
  await ref.update({
    studyContent: input.studyContent,
    quality: input.quality,
    reflectionNote: input.reflectionNote,
    updatedAt: now,
  });

  const session = await getSession(input.sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  return session;
}

export async function deleteSessionDoc(sessionId: string): Promise<void> {
  await sessionCollection().doc(sessionId).delete();
}

export async function updateSessionProcessing(sessionId: string): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    status: "processing",
    errorMessage: null,
    updatedAt: Timestamp.now(),
  });
}

export async function updateSessionReady(
  sessionId: string,
  timelapsePath: string,
  thumbnailPath: string | null,
): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    status: "ready",
    timelapsePath,
    thumbnailPath,
    updatedAt: Timestamp.now(),
  });
}

export async function updateSessionFailed(
  sessionId: string,
  errorMessage: string,
): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    status: "failed",
    errorMessage,
    updatedAt: Timestamp.now(),
  });
}

export async function getWeeklyGoalMinutes(): Promise<number> {
  const snapshot = await getFirestoreDb()
    .collection(SETTINGS_COLLECTION)
    .doc(WEEKLY_GOAL_DOC)
    .get();
  const data = snapshot.data() as { targetWeeklyStudyMinutes?: unknown } | undefined;

  return typeof data?.targetWeeklyStudyMinutes === "number"
    ? data.targetWeeklyStudyMinutes
    : 0;
}

export async function setWeeklyGoalMinutes(targetWeeklyStudyMinutes: number): Promise<void> {
  await getFirestoreDb().collection(SETTINGS_COLLECTION).doc(WEEKLY_GOAL_DOC).set(
    {
      targetWeeklyStudyMinutes,
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
}
