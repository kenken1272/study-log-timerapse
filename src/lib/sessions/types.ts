import type { Timestamp } from "@google-cloud/firestore";

export type SessionType = "recorded" | "offline";
export type SessionStatus =
  | "recording"
  | "paused"
  | "interrupted"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed";
export type UploadStatus =
  | "idle"
  | "uploading"
  | "offline_pending"
  | "uploaded"
  | "failed";
export type CleanupStatus = "not_started" | "deleting" | "done" | "failed";
export type InterruptionReason =
  | "network_offline"
  | "tab_closed"
  | "browser_crash"
  | "manual_pause"
  | "unknown";
export type AnalysisStatus = "none" | "pending" | "processing" | "done" | "failed";
export type TimelapseSpeed = 30 | 60 | 120;
export type StudyQuality = 1 | 2 | 3 | 4 | 5;
export type FocusLabel = "かなり低い" | "低い" | "普通" | "高い" | "とても高い";

export type SessionChunk = {
  segmentIndex: number;
  index: number;
  objectPath: string;
  sizeBytes: number;
  uploadedAt: Timestamp;
  deletedAt: Timestamp | null;
};

export type BreakLog = {
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  durationSec: number | null;
};

export type RecordingSegment = {
  segmentIndex: number;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  reasonEnded: InterruptionReason | "finished" | null;
};

export type AnalysisResult = {
  focusScore: number;
  focusLabel: FocusLabel;
  studyDetected: boolean;
  estimatedAbsenceMinutes: number;
  estimatedPhoneUseMinutes: number;
  estimatedWritingReadingMinutes: number;
  summary: string;
  evidence: string[];
  uncertainty: string;
  advice: string;
};

export type StudyAnalysisResult = AnalysisResult;

export type StudySession = {
  id: string;
  ownerUid: string;
  type: SessionType;
  targetStudyMinutes: number | null;
  targetStudySec: number | null;
  actualStudySec: number;
  totalElapsedSec: number | null;
  totalBreakSec: number;
  achievementRate: number | null;
  speed: TimelapseSpeed | null;
  status: SessionStatus;
  uploadStatus: UploadStatus;
  cleanupStatus: CleanupStatus;
  chunksDeletedAt: Timestamp | null;
  chunksDeletedCount: number;
  chunksStorageBytes: number;
  cleanupErrorMessage: string | null;
  resumeToken: string | null;
  resumable: boolean;
  lastHeartbeatAt: Timestamp | null;
  interruptedAt: Timestamp | null;
  interruptionReason: InterruptionReason | null;
  recordingSegments: RecordingSegment[];
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  chunkCount: number;
  chunks: SessionChunk[];
  breakLogs: BreakLog[];
  studyContent: string | null;
  quality: StudyQuality | null;
  reflectionNote: string | null;
  timelapsePath: string | null;
  timelapseSizeBytes: number | null;
  thumbnailPath: string | null;
  errorMessage: string | null;
  analysisStatus: AnalysisStatus;
  analysisRequestedAt: Timestamp | null;
  analysisStartedAt: Timestamp | null;
  analysisFinishedAt: Timestamp | null;
  analysisModel: string | null;
  analysisErrorMessage: string | null;
  analysisResult: AnalysisResult | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type JsonSessionChunk = Omit<SessionChunk, "uploadedAt" | "deletedAt"> & {
  uploadedAt: string;
  deletedAt: string | null;
};

export type JsonBreakLog = Omit<BreakLog, "startedAt" | "endedAt"> & {
  startedAt: string;
  endedAt: string | null;
};

export type JsonRecordingSegment = Omit<RecordingSegment, "startedAt" | "endedAt"> & {
  startedAt: string;
  endedAt: string | null;
};

export type JsonStudySession = Omit<
  StudySession,
  | "startedAt"
  | "endedAt"
  | "createdAt"
  | "updatedAt"
  | "chunks"
  | "breakLogs"
  | "recordingSegments"
  | "chunksDeletedAt"
  | "lastHeartbeatAt"
  | "interruptedAt"
  | "analysisRequestedAt"
  | "analysisStartedAt"
  | "analysisFinishedAt"
> & {
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  chunks: JsonSessionChunk[];
  breakLogs: JsonBreakLog[];
  recordingSegments: JsonRecordingSegment[];
  chunksDeletedAt: string | null;
  lastHeartbeatAt: string | null;
  interruptedAt: string | null;
  analysisRequestedAt: string | null;
  analysisStartedAt: string | null;
  analysisFinishedAt: string | null;
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
