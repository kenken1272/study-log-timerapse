import type { Timestamp } from "@google-cloud/firestore";

export type SessionType = "recorded" | "offline";
export type SessionStatus =
  | "recording"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed";
export type TimelapseSpeed = 30 | 60 | 120;
export type StudyQuality = 1 | 2 | 3 | 4 | 5;

export type SessionChunk = {
  index: number;
  objectPath: string;
  sizeBytes: number;
  uploadedAt: Timestamp;
};

export type BreakLog = {
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  durationSec: number | null;
};

export type StudySession = {
  id: string;
  type: SessionType;
  targetStudyMinutes: number | null;
  targetStudySec: number | null;
  actualStudySec: number;
  totalElapsedSec: number | null;
  totalBreakSec: number;
  achievementRate: number | null;
  speed: TimelapseSpeed | null;
  status: SessionStatus;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  chunkCount: number;
  chunks: SessionChunk[];
  breakLogs: BreakLog[];
  studyContent: string | null;
  quality: StudyQuality | null;
  reflectionNote: string | null;
  timelapsePath: string | null;
  thumbnailPath: string | null;
  errorMessage: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type JsonSessionChunk = Omit<SessionChunk, "uploadedAt"> & {
  uploadedAt: string;
};

export type JsonBreakLog = Omit<BreakLog, "startedAt" | "endedAt"> & {
  startedAt: string;
  endedAt: string | null;
};

export type JsonStudySession = Omit<
  StudySession,
  "startedAt" | "endedAt" | "createdAt" | "updatedAt" | "chunks" | "breakLogs"
> & {
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  chunks: JsonSessionChunk[];
  breakLogs: JsonBreakLog[];
};

export type DashboardStats = {
  todayStudySec: number;
  weekStudySec: number;
  targetWeeklyStudyMinutes: number;
  weeklyAchievementRate: number;
  totalStudySec: number;
  totalBreakSec: number;
  totalSessions: number;
  averageQuality: number | null;
};
