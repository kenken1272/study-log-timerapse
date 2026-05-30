import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { getFirestoreDb } from "@/lib/firebase/admin";
import type {
  AnalysisResult,
  AnalysisStatus,
  BreakLog,
  CleanupStatus,
  InterruptionReason,
  JsonBreakLog,
  JsonRecordingSegment,
  JsonSessionChunk,
  JsonStudySession,
  RecordingSegment,
  StudyQuality,
  StudySession,
  TimelapseSpeed,
  UploadStatus,
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

function normalizeChunk(
  chunk: Partial<StudySession["chunks"][number]>,
): StudySession["chunks"][number] {
  return {
    segmentIndex: typeof chunk.segmentIndex === "number" ? chunk.segmentIndex : 0,
    index: typeof chunk.index === "number" ? chunk.index : 0,
    objectPath: typeof chunk.objectPath === "string" ? chunk.objectPath : "",
    sizeBytes: typeof chunk.sizeBytes === "number" ? chunk.sizeBytes : 0,
    uploadedAt: chunk.uploadedAt instanceof Timestamp ? chunk.uploadedAt : Timestamp.now(),
    deletedAt: chunk.deletedAt instanceof Timestamp ? chunk.deletedAt : null,
  };
}

function normalizeRecordingSegments(
  value: unknown,
  startedAt: Timestamp,
): RecordingSegment[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      {
        segmentIndex: 0,
        startedAt,
        endedAt: null,
        reasonEnded: null,
      },
    ];
  }

  return value.map((item, index) => {
    const segment = item as Partial<RecordingSegment>;
    return {
      segmentIndex: typeof segment.segmentIndex === "number" ? segment.segmentIndex : index,
      startedAt: segment.startedAt instanceof Timestamp ? segment.startedAt : startedAt,
      endedAt: segment.endedAt instanceof Timestamp ? segment.endedAt : null,
      reasonEnded: segment.reasonEnded ?? null,
    };
  });
}

export function toJsonSession(session: StudySession): JsonStudySession {
  const chunks: JsonSessionChunk[] = session.chunks.map((chunk) => ({
    ...chunk,
    uploadedAt: chunk.uploadedAt.toDate().toISOString(),
    deletedAt: timestampToIso(chunk.deletedAt),
  }));
  const breakLogs: JsonBreakLog[] = session.breakLogs.map((breakLog) => ({
    ...breakLog,
    startedAt: breakLog.startedAt.toDate().toISOString(),
    endedAt: timestampToIso(breakLog.endedAt),
  }));
  const recordingSegments: JsonRecordingSegment[] = session.recordingSegments.map(
    (segment) => ({
      ...segment,
      startedAt: segment.startedAt.toDate().toISOString(),
      endedAt: timestampToIso(segment.endedAt),
    }),
  );

  return {
    ...session,
    startedAt: session.startedAt.toDate().toISOString(),
    endedAt: timestampToIso(session.endedAt),
    createdAt: session.createdAt.toDate().toISOString(),
    updatedAt: session.updatedAt.toDate().toISOString(),
    chunks,
    breakLogs,
    recordingSegments,
    chunksDeletedAt: timestampToIso(session.chunksDeletedAt),
    lastHeartbeatAt: timestampToIso(session.lastHeartbeatAt),
    interruptedAt: timestampToIso(session.interruptedAt),
    analysisRequestedAt: timestampToIso(session.analysisRequestedAt),
    analysisStartedAt: timestampToIso(session.analysisStartedAt),
    analysisFinishedAt: timestampToIso(session.analysisFinishedAt),
    localAnalysisRequestedAt: timestampToIso(session.localAnalysisRequestedAt),
    localAnalysisStartedAt: timestampToIso(session.localAnalysisStartedAt),
    localAnalysisFinishedAt: timestampToIso(session.localAnalysisFinishedAt),
  };
}

function snapshotToSession(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): StudySession | null {
  const data = snapshot.data() as Partial<Omit<StudySession, "id">> | undefined;
  if (!data) {
    return null;
  }
  const startedAt = data.startedAt instanceof Timestamp ? data.startedAt : Timestamp.now();
  const now = Timestamp.now();

  return {
    id: snapshot.id,
    type: data.type ?? "recorded",
    targetStudyMinutes: data.targetStudyMinutes ?? null,
    targetStudySec: data.targetStudySec ?? null,
    actualStudySec: data.actualStudySec ?? 0,
    totalElapsedSec: data.totalElapsedSec ?? null,
    totalBreakSec: data.totalBreakSec ?? 0,
    achievementRate: data.achievementRate ?? null,
    speed: data.speed ?? null,
    status: data.status ?? "ready",
    uploadStatus: data.uploadStatus ?? "uploaded",
    cleanupStatus: data.cleanupStatus ?? "not_started",
    chunksDeletedAt: data.chunksDeletedAt ?? null,
    chunksDeletedCount: data.chunksDeletedCount ?? 0,
    chunksStorageBytes: data.chunksStorageBytes ?? 0,
    cleanupErrorMessage: data.cleanupErrorMessage ?? null,
    resumeToken: data.resumeToken ?? null,
    resumable: data.resumable ?? data.status === "recording",
    lastHeartbeatAt: data.lastHeartbeatAt ?? null,
    interruptedAt: data.interruptedAt ?? null,
    interruptionReason: data.interruptionReason ?? null,
    recordingSegments: normalizeRecordingSegments(data.recordingSegments, startedAt),
    startedAt,
    endedAt: data.endedAt ?? null,
    chunkCount: data.chunkCount ?? data.chunks?.length ?? 0,
    chunks: (data.chunks ?? []).map((chunk) => normalizeChunk(chunk)),
    breakLogs: data.breakLogs ?? [],
    studyContent: data.studyContent ?? null,
    quality: data.quality ?? null,
    reflectionNote: data.reflectionNote ?? null,
    timelapsePath: data.timelapsePath ?? null,
    timelapseSizeBytes: data.timelapseSizeBytes ?? null,
    thumbnailPath: data.thumbnailPath ?? null,
    errorMessage: data.errorMessage ?? null,
    analysisStatus: data.analysisStatus ?? "none",
    analysisRequestedAt: data.analysisRequestedAt ?? null,
    analysisStartedAt: data.analysisStartedAt ?? null,
    analysisFinishedAt: data.analysisFinishedAt ?? null,
    analysisModel: data.analysisModel ?? null,
    analysisErrorMessage: data.analysisErrorMessage ?? null,
    analysisResult: data.analysisResult ?? null,
    localAnalysisStatus: data.localAnalysisStatus ?? "none",
    localAnalysisRequestedAt: data.localAnalysisRequestedAt ?? null,
    localAnalysisStartedAt: data.localAnalysisStartedAt ?? null,
    localAnalysisFinishedAt: data.localAnalysisFinishedAt ?? null,
    localAnalysisModel: data.localAnalysisModel ?? null,
    localAnalysisErrorMessage: data.localAnalysisErrorMessage ?? null,
    localAnalysisResult: data.localAnalysisResult ?? null,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
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
    uploadStatus: "idle",
    cleanupStatus: "not_started",
    chunksDeletedAt: null,
    chunksDeletedCount: 0,
    chunksStorageBytes: 0,
    cleanupErrorMessage: null,
    resumeToken: randomUUID(),
    resumable: true,
    lastHeartbeatAt: now,
    interruptedAt: null,
    interruptionReason: null,
    recordingSegments: [
      {
        segmentIndex: 0,
        startedAt: now,
        endedAt: null,
        reasonEnded: null,
      },
    ],
    startedAt: now,
    endedAt: null,
    chunkCount: 0,
    chunks: [],
    breakLogs: [],
    studyContent: null,
    quality: null,
    reflectionNote: null,
    timelapsePath: null,
    timelapseSizeBytes: null,
    thumbnailPath: null,
    errorMessage: null,
    analysisStatus: "none",
    analysisRequestedAt: null,
    analysisStartedAt: null,
    analysisFinishedAt: null,
    analysisModel: null,
    analysisErrorMessage: null,
    analysisResult: null,
    localAnalysisStatus: "none",
    localAnalysisRequestedAt: null,
    localAnalysisStartedAt: null,
    localAnalysisFinishedAt: null,
    localAnalysisModel: null,
    localAnalysisErrorMessage: null,
    localAnalysisResult: null,
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
    uploadStatus: "uploaded",
    cleanupStatus: "done",
    chunksDeletedAt: null,
    chunksDeletedCount: 0,
    chunksStorageBytes: 0,
    cleanupErrorMessage: null,
    resumeToken: null,
    resumable: false,
    lastHeartbeatAt: null,
    interruptedAt: null,
    interruptionReason: null,
    recordingSegments: [],
    startedAt,
    endedAt: startedAt,
    chunkCount: 0,
    chunks: [],
    breakLogs: [],
    studyContent: input.studyContent,
    quality: input.quality,
    reflectionNote: input.reflectionNote,
    timelapsePath: null,
    timelapseSizeBytes: null,
    thumbnailPath: null,
    errorMessage: null,
    analysisStatus: "none",
    analysisRequestedAt: null,
    analysisStartedAt: null,
    analysisFinishedAt: null,
    analysisModel: null,
    analysisErrorMessage: null,
    analysisResult: null,
    localAnalysisStatus: "none",
    localAnalysisRequestedAt: null,
    localAnalysisStartedAt: null,
    localAnalysisFinishedAt: null,
    localAnalysisModel: null,
    localAnalysisErrorMessage: null,
    localAnalysisResult: null,
    createdAt: now,
    updatedAt: now,
  };

  await doc.set(session);
  return session;
}

export async function registerChunk(input: {
  sessionId: string;
  segmentIndex: number;
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
      segmentIndex: input.segmentIndex,
      index: input.index,
      objectPath: input.objectPath,
      sizeBytes: input.sizeBytes,
      uploadedAt: Timestamp.now(),
      deletedAt: null,
    };
    const existing = session.chunks.find(
      (item) => item.segmentIndex === input.segmentIndex && item.index === input.index,
    );
    const chunks = existing
      ? session.chunks
      : [...session.chunks, chunk].sort(
          (a, b) => a.segmentIndex - b.segmentIndex || a.index - b.index,
        );

    transaction.update(ref, {
      chunks,
      chunkCount: chunks.length,
      uploadStatus: "uploaded" satisfies UploadStatus,
      updatedAt: Timestamp.now(),
    });
  });
}

export async function updateUploadStatus(
  sessionId: string,
  uploadStatus: UploadStatus,
): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    uploadStatus,
    updatedAt: Timestamp.now(),
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
    const recordingSegments = session.recordingSegments.map((segment) =>
      segment.endedAt === null
        ? { ...segment, endedAt, reasonEnded: "finished" as const }
        : segment,
    );
    const totalElapsedSec = recordingSegments.reduce((sum, segment) => {
      const segmentEndedAt = segment.endedAt ?? endedAt;
      return (
        sum +
        Math.max(
          0,
          Math.round((segmentEndedAt.toMillis() - segment.startedAt.toMillis()) / 1000),
        )
      );
    }, 0);
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
      uploadStatus: "uploaded",
      resumable: false,
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

    transaction.update(ref, { ...updatedSession, recordingSegments });
    return { ...updatedSession, recordingSegments };
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
  timelapseSizeBytes: number,
  thumbnailPath: string | null,
): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    status: "ready",
    timelapsePath,
    timelapseSizeBytes,
    thumbnailPath,
    analysisStatus: "none" satisfies AnalysisStatus,
    updatedAt: Timestamp.now(),
  });
}

export async function updateSessionCleanupDeleting(sessionId: string): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    cleanupStatus: "deleting" satisfies CleanupStatus,
    cleanupErrorMessage: null,
    updatedAt: Timestamp.now(),
  });
}

export async function updateSessionCleanupDone(input: {
  sessionId: string;
  deletedObjectPaths: string[];
  chunksStorageBytes: number;
}): Promise<void> {
  const ref = sessionCollection().doc(input.sessionId);
  await getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }

    const now = Timestamp.now();
    const deletedSet = new Set(input.deletedObjectPaths);
    const chunks = session.chunks.map((chunk) =>
      deletedSet.has(chunk.objectPath) ? { ...chunk, deletedAt: now } : chunk,
    );

    transaction.update(ref, {
      chunks,
      chunksDeletedAt: now,
      chunksDeletedCount: input.deletedObjectPaths.length,
      chunksStorageBytes: input.chunksStorageBytes,
      cleanupStatus: "done" satisfies CleanupStatus,
      cleanupErrorMessage: null,
      updatedAt: now,
    });
  });
}

export async function updateSessionCleanupFailed(
  sessionId: string,
  cleanupErrorMessage: string,
): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    cleanupStatus: "failed" satisfies CleanupStatus,
    cleanupErrorMessage,
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

export async function listResumableSessions(): Promise<StudySession[]> {
  const snapshot = await sessionCollection()
    .where("resumable", "==", true)
    .orderBy("updatedAt", "desc")
    .limit(10)
    .get();

  return snapshot.docs
    .map((doc) => snapshotToSession(doc))
    .filter((session): session is StudySession => {
      return (
        session !== null &&
        (session.status === "recording" ||
          session.status === "interrupted" ||
          session.status === "paused")
      );
    });
}

export async function heartbeatSession(sessionId: string): Promise<void> {
  await sessionCollection().doc(sessionId).update({
    lastHeartbeatAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

export async function interruptSession(input: {
  sessionId: string;
  reason: InterruptionReason;
  uploadStatus?: UploadStatus;
}): Promise<void> {
  const ref = sessionCollection().doc(input.sessionId);
  await getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }
    const now = Timestamp.now();
    const recordingSegments = session.recordingSegments.map((segment, index, list) =>
      index === list.length - 1 && segment.endedAt === null
        ? { ...segment, endedAt: now, reasonEnded: input.reason }
        : segment,
    );

    transaction.update(ref, {
      status: "interrupted" satisfies StudySession["status"],
      interruptedAt: now,
      interruptionReason: input.reason,
      uploadStatus: input.uploadStatus ?? session.uploadStatus,
      recordingSegments,
      resumable: true,
      updatedAt: now,
    });
  });
}

export async function resumeSession(sessionId: string): Promise<number> {
  const ref = sessionCollection().doc(sessionId);
  return getFirestoreDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const session = snapshotToSession(snapshot);
    if (!session) {
      throw new Error("Session not found.");
    }
    const nextSegmentIndex =
      session.recordingSegments.reduce(
        (max, segment) => Math.max(max, segment.segmentIndex),
        -1,
      ) + 1;
    const now = Timestamp.now();
    const recordingSegments = [
      ...session.recordingSegments,
      {
        segmentIndex: nextSegmentIndex,
        startedAt: now,
        endedAt: null,
        reasonEnded: null,
      },
    ];

    transaction.update(ref, {
      status: "recording" satisfies StudySession["status"],
      resumable: true,
      interruptedAt: null,
      interruptionReason: null,
      recordingSegments,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    return nextSegmentIndex;
  });
}

export async function updateSessionAnalysisProcessing(input: {
  sessionId: string;
  model: string;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    analysisStatus: "processing" satisfies AnalysisStatus,
    analysisRequestedAt: now,
    analysisStartedAt: now,
    analysisFinishedAt: null,
    analysisModel: input.model,
    analysisErrorMessage: null,
    updatedAt: now,
  });
}

export async function updateSessionAnalysisDone(input: {
  sessionId: string;
  model: string;
  analysisResult: AnalysisResult;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    analysisStatus: "done" satisfies AnalysisStatus,
    analysisFinishedAt: now,
    analysisModel: input.model,
    analysisErrorMessage: null,
    analysisResult: input.analysisResult,
    updatedAt: now,
  });
}

export async function updateSessionAnalysisFailed(input: {
  sessionId: string;
  model: string;
  errorMessage: string;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    analysisStatus: "failed" satisfies AnalysisStatus,
    analysisFinishedAt: now,
    analysisModel: input.model,
    analysisErrorMessage: input.errorMessage,
    updatedAt: now,
  });
}

export async function updateSessionLocalAnalysisProcessing(input: {
  sessionId: string;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    localAnalysisStatus: "processing" satisfies AnalysisStatus,
    localAnalysisRequestedAt: now,
    localAnalysisStartedAt: now,
    localAnalysisFinishedAt: null,
    localAnalysisErrorMessage: null,
    updatedAt: now,
  });
}

export async function updateSessionLocalAnalysisDone(input: {
  sessionId: string;
  model: string;
  analysisResult: AnalysisResult;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    localAnalysisStatus: "done" satisfies AnalysisStatus,
    localAnalysisFinishedAt: now,
    localAnalysisModel: input.model,
    localAnalysisErrorMessage: null,
    localAnalysisResult: input.analysisResult,
    updatedAt: now,
  });
}

export async function updateSessionLocalAnalysisFailed(input: {
  sessionId: string;
  errorMessage: string;
}): Promise<void> {
  const now = Timestamp.now();
  await sessionCollection().doc(input.sessionId).update({
    localAnalysisStatus: "failed" satisfies AnalysisStatus,
    localAnalysisFinishedAt: now,
    localAnalysisErrorMessage: input.errorMessage,
    updatedAt: now,
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
