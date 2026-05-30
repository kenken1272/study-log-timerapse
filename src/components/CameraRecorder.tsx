"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import fixWebmDuration from "fix-webm-duration";
import { Play, Save, X } from "lucide-react";
import type { JsonRecordingSegment, JsonStudySession, StudyQuality } from "@/lib/sessions/types";
import {
  deleteStoredChunk,
  listPendingChunks,
  saveChunk,
  updateStoredChunk,
  type StoredChunk,
} from "@/lib/client/chunkStore";
import { isOnline, onOffline, onOnline } from "@/lib/client/network";
import {
  clearActiveSession,
  loadActiveSession,
  markInterrupted,
  saveActiveSession,
  updateBreakState,
  updateChunkIndex,
  type ActiveSessionState,
} from "@/lib/client/sessionResume";
import { fetchWithRetry, friendlyFetchError } from "@/lib/client/fetchWithRetry";
import { formatDuration, formatShortDate } from "@/lib/time/format";
import { QualitySelector } from "@/components/QualitySelector";
import { RecordingStatusPanel } from "@/components/RecordingStatusPanel";
import { SmallCameraPreview } from "@/components/SmallCameraPreview";
import { StudyMinutesControl } from "@/components/StudyMinutesControl";

const CHUNK_TIMESLICE_MS = 30_000;
const MIN_CHUNK_DURATION_MS = 1_000;

type SessionResponse = {
  session: JsonStudySession;
};

type ResumeResponse = {
  segmentIndex: number;
};

type UploadUrlResponse = {
  uploadUrl: string;
  objectPath: string;
};

type RecorderPhase = "setup" | "recording" | "review" | "processing";

function preferredMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
    return "video/webm;codecs=vp8";
  }
  if (MediaRecorder.isTypeSupported("video/webm")) {
    return "video/webm";
  }

  return "";
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(errorBody.error ?? "Request failed.");
  }

  return (await response.json()) as T;
}

function segmentDurationSec(segment: JsonRecordingSegment, fallbackEndedAtMs = Date.now()): number {
  const startedAtMs = new Date(segment.startedAt).getTime();
  const endedAtMs = segment.endedAt ? new Date(segment.endedAt).getTime() : fallbackEndedAtMs;
  return Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
}

function completedSegmentStudySec(session: JsonStudySession): number {
  const recordedSec = session.recordingSegments
    .filter((segment) => segment.endedAt !== null)
    .reduce((sum, segment) => sum + segmentDurationSec(segment), 0);

  return Math.max(0, recordedSec - session.totalBreakSec);
}

function activeSessionFromCreatedSession(
  session: JsonStudySession,
  targetStudyMinutes: number,
): ActiveSessionState {
  return {
    sessionId: session.id,
    segmentIndex: 0,
    chunkIndex: 0,
    startedAtMs: Date.now(),
    targetStudyMinutes,
    speed: session.speed,
    isBreakActive: false,
    breakStartedAtMs: null,
    accumulatedBreakSec: 0,
    interruptedReason: null,
  };
}

export function CameraRecorder() {
  const router = useRouter();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<JsonStudySession | null>(null);
  const uploadPromisesRef = useRef<Promise<void>[]>([]);
  const successfulChunkCountRef = useRef(0);
  const chunkIndexRef = useRef(0);
  const segmentIndexRef = useRef(0);
  const currentSegmentStartedAtRef = useRef(0);
  const baseStudySecRef = useRef(0);
  const accumulatedBreakSecRef = useRef(0);
  const breakStartedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkTimerRef = useRef<number | null>(null);
  const shouldContinueRecordingRef = useRef(false);

  const [targetStudyMinutes, setTargetStudyMinutes] = useState(60);
  const [phase, setPhase] = useState<RecorderPhase>("setup");
  const [actualStudySec, setActualStudySec] = useState(0);
  const [isBreakActive, setIsBreakActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [studyContent, setStudyContent] = useState("");
  const [quality, setQuality] = useState<StudyQuality>(3);
  const [reflectionNote, setReflectionNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pendingUploadCount, setPendingUploadCount] = useState(0);
  const [resumableSession, setResumableSession] = useState<JsonStudySession | null>(null);
  const [activeSessionState, setActiveSessionState] = useState<ActiveSessionState | null>(() =>
    typeof window === "undefined" ? null : loadActiveSession(),
  );

  const refreshPendingCount = useCallback(async (sessionId?: string) => {
    if (typeof indexedDB === "undefined") {
      return;
    }
    const pending = await listPendingChunks(sessionId);
    setPendingUploadCount(pending.length);
  }, []);

  const uploadStoredChunk = useCallback(async (chunk: StoredChunk): Promise<void> => {
    await updateStoredChunk(chunk.id, {
      uploadStatus: "uploading",
      errorMessage: null,
    });

    const uploadData = await postJson<UploadUrlResponse>(
      `/api/sessions/${chunk.sessionId}/upload-url`,
      {
        segmentIndex: chunk.segmentIndex,
        chunkIndex: chunk.chunkIndex,
        contentType: chunk.contentType,
      },
    );
    const uploadResponse = await fetchWithRetry(
      uploadData.uploadUrl,
      {
        method: "PUT",
        headers: { "Content-Type": chunk.contentType },
        body: chunk.blob,
      },
      { retries: 3, delayMs: 1200 },
    );
    if (!uploadResponse.ok) {
      throw new Error("GCS chunk upload failed.");
    }

    await postJson<{ ok: true }>(`/api/sessions/${chunk.sessionId}/chunk-complete`, {
      segmentIndex: chunk.segmentIndex,
      chunkIndex: chunk.chunkIndex,
      objectPath: uploadData.objectPath,
      sizeBytes: chunk.sizeBytes,
    });
    successfulChunkCountRef.current += 1;
    await updateStoredChunk(chunk.id, {
      uploadStatus: "uploaded",
      objectPath: uploadData.objectPath,
      errorMessage: null,
    });
    await deleteStoredChunk(chunk.id);
  }, []);

  const uploadPendingChunks = useCallback(
    async (sessionId?: string) => {
      if (!isOnline()) {
        setOnline(false);
        return;
      }

      const pending = await listPendingChunks(sessionId);
      setPendingUploadCount(pending.length);
      for (const chunk of pending) {
        try {
          await uploadStoredChunk(chunk);
        } catch (error) {
          const errorMessage = friendlyFetchError(error, "chunk upload failed.");
          await updateStoredChunk(chunk.id, {
            uploadStatus: "failed",
            errorMessage,
          });
          setMessage(errorMessage);
          break;
        } finally {
          await refreshPendingCount(sessionId);
        }
      }
    },
    [refreshPendingCount, uploadStoredChunk],
  );

  useEffect(() => {
    const active = loadActiveSession();
    if (!active) {
      return;
    }

    void fetch(`/api/sessions/${active.sessionId}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("セッションを取得できませんでした。");
        }
        return response.json() as Promise<{ session: JsonStudySession }>;
      })
      .then((body) => {
        if (
          body.session.status === "recording" ||
          body.session.status === "interrupted" ||
          body.session.status === "paused"
        ) {
          setResumableSession(body.session);
          setTargetStudyMinutes(body.session.targetStudyMinutes ?? active.targetStudyMinutes);
          void fetch(`/api/sessions/${body.session.id}/interrupt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reason: active.interruptedReason ?? "browser_crash",
              uploadStatus: "offline_pending",
            }),
          });
        }
        void refreshPendingCount(active.sessionId);
      })
      .catch(() => {
        clearActiveSession();
        setActiveSessionState(null);
      });
  }, [refreshPendingCount]);

  useEffect(() => {
    const cleanupOnline = onOnline(() => {
      setOnline(true);
      void uploadPendingChunks(sessionRef.current?.id ?? activeSessionState?.sessionId);
    });
    const cleanupOffline = onOffline(() => {
      setOnline(false);
      markInterrupted("network_offline");
      const session = sessionRef.current;
      if (session) {
        void fetchWithRetry(`/api/sessions/${session.id}/upload-pending`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadStatus: "offline_pending",
          }),
        }).catch(() => undefined);
      }
    });

    return () => {
      cleanupOnline();
      cleanupOffline();
    };
  }, [activeSessionState?.sessionId, uploadPendingChunks]);

  useEffect(() => {
    if (phase !== "recording") {
      return;
    }

    const heartbeat = setInterval(() => {
      const session = sessionRef.current;
      if (session && isOnline()) {
        void fetch(`/api/sessions/${session.id}/heartbeat`, { method: "POST" });
      }
    }, 30_000);

    return () => clearInterval(heartbeat);
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") {
      return;
    }

    function handleBeforeUnload() {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      markInterrupted("tab_closed");
      const payload = JSON.stringify({
        reason: "tab_closed",
        uploadStatus: pendingUploadCount > 0 ? "offline_pending" : "uploaded",
      });
      navigator.sendBeacon(
        `/api/sessions/${session.id}/interrupt`,
        new Blob([payload], { type: "application/json" }),
      );
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [pendingUploadCount, phase]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (chunkTimerRef.current) {
        clearTimeout(chunkTimerRef.current);
      }
      shouldContinueRecordingRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording" || !previewRef.current || !streamRef.current) {
      return;
    }

    const preview = previewRef.current;
    preview.srcObject = streamRef.current;
    void preview.play().catch(() => {
      setMessage("カメラプレビューを再生できませんでした。ブラウザの自動再生設定を確認してください。");
    });
  }, [phase]);

  function persistActiveSession() {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    saveActiveSession({
      sessionId: session.id,
      segmentIndex: segmentIndexRef.current,
      chunkIndex: chunkIndexRef.current,
      startedAtMs: currentSegmentStartedAtRef.current,
      targetStudyMinutes,
      speed: session.speed,
      isBreakActive,
      breakStartedAtMs: breakStartedAtRef.current,
      accumulatedBreakSec: accumulatedBreakSecRef.current,
      interruptedReason: null,
    });
  }

  function refreshActualStudySec() {
    if (currentSegmentStartedAtRef.current === 0) {
      return;
    }

    const currentSegmentSec = Math.floor(
      (Date.now() - currentSegmentStartedAtRef.current) / 1000,
    );
    const activeBreakSec =
      breakStartedAtRef.current === null
        ? 0
        : Math.floor((Date.now() - breakStartedAtRef.current) / 1000);
    setActualStudySec(
      Math.max(
        0,
        baseStudySecRef.current +
          currentSegmentSec -
          accumulatedBreakSecRef.current -
          activeBreakSec,
      ),
    );
  }

  async function storeAndMaybeUploadChunk(
    blob: Blob,
    chunkIndex: number,
    sessionId: string,
    segmentIndex: number,
    contentType: string,
  ) {
    if (blob.size === 0) {
      return;
    }

    const stored = await saveChunk({
      sessionId,
      segmentIndex,
      chunkIndex,
      blob,
      sizeBytes: blob.size,
      contentType,
      uploadStatus: "pending",
      objectPath: null,
      errorMessage: null,
    });
    await refreshPendingCount(sessionId);

    if (!isOnline()) {
      setOnline(false);
      setMessage("オフラインです。動画chunkはこのブラウザに一時保存しています。");
      await fetchWithRetry(`/api/sessions/${sessionId}/upload-pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadStatus: "offline_pending",
        }),
      }).catch(() => undefined);
      return;
    }

    await uploadStoredChunk(stored);
    await refreshPendingCount(sessionId);
  }

  function enqueueRecordedBlob(blob: Blob, contentType: string): Promise<void> {
    const session = sessionRef.current;
    if (blob.size === 0 || !session) {
      return Promise.resolve();
    }

    const nextChunkIndex = chunkIndexRef.current;
    const currentSegmentIndex = segmentIndexRef.current;
    chunkIndexRef.current += 1;
    updateChunkIndex(chunkIndexRef.current);
    const promise = storeAndMaybeUploadChunk(
      blob,
      nextChunkIndex,
      session.id,
      currentSegmentIndex,
      contentType,
    ).catch((error: unknown) => {
      const errorMessage = friendlyFetchError(error, "chunk upload failed.");
      setMessage(errorMessage);
    });
    uploadPromisesRef.current.push(promise);
    return promise;
  }

  async function fixAndEnqueueRecordedBlob(
    blob: Blob,
    contentType: string,
    durationMs: number,
  ) {
    if (durationMs < MIN_CHUNK_DURATION_MS) {
      return;
    }

    const fixedBlob = await fixWebmDuration(blob, durationMs, { logger: false }).catch(() => blob);
    await enqueueRecordedBlob(fixedBlob, contentType);
  }

  function startStandaloneChunkRecorder(stream: MediaStream, mimeType: string) {
    const chunks: Blob[] = [];
    const startedAtMs = Date.now();
    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (chunkTimerRef.current) {
        clearTimeout(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      if (chunks.length > 0) {
        const contentType = chunks[0]?.type || mimeType;
        const rawBlob = new Blob(chunks, { type: contentType });
        const promise = fixAndEnqueueRecordedBlob(rawBlob, contentType, durationMs);
        uploadPromisesRef.current.push(promise);
      }

      const hasLiveTrack = stream.getTracks().some((track) => track.readyState === "live");
      if (shouldContinueRecordingRef.current && hasLiveTrack) {
        window.setTimeout(() => startStandaloneChunkRecorder(stream, mimeType), 0);
      }
    };
    recorder.start();
    chunkTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, CHUNK_TIMESLICE_MS);
  }

  async function stopCurrentRecorder(): Promise<void> {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
  }

  async function startRecorderForSession(input: {
    session: JsonStudySession;
    segmentIndex: number;
    chunkIndex: number;
    baseStudySec: number;
  }) {
    const mimeType = preferredMimeType();
    if (!mimeType) {
      throw new Error("このブラウザはWebM録画に対応していません。");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: false,
    });
    streamRef.current = stream;
    if (previewRef.current) {
      previewRef.current.srcObject = stream;
    }

    sessionRef.current = input.session;
    segmentIndexRef.current = input.segmentIndex;
    chunkIndexRef.current = input.chunkIndex;
    successfulChunkCountRef.current = input.session.chunkCount;
    uploadPromisesRef.current = [];
    currentSegmentStartedAtRef.current = Date.now();
    baseStudySecRef.current = input.baseStudySec;
    accumulatedBreakSecRef.current = 0;
    breakStartedAtRef.current = null;
    setActualStudySec(input.baseStudySec);
    setIsBreakActive(false);

    saveActiveSession({
      sessionId: input.session.id,
      segmentIndex: input.segmentIndex,
      chunkIndex: input.chunkIndex,
      startedAtMs: Date.now(),
      targetStudyMinutes: input.session.targetStudyMinutes ?? targetStudyMinutes,
      speed: input.session.speed,
      isBreakActive: false,
      breakStartedAtMs: null,
      accumulatedBreakSec: 0,
      interruptedReason: null,
    });

    shouldContinueRecordingRef.current = true;
    startStandaloneChunkRecorder(stream, mimeType);
    timerRef.current = setInterval(() => {
      refreshActualStudySec();
      persistActiveSession();
    }, 1000);
    setPhase("recording");
  }

  async function handleStart() {
    setIsBusy(true);
    setMessage(null);
    try {
      const created = await postJson<SessionResponse>("/api/sessions", {
        targetStudyMinutes,
      });
      saveActiveSession(activeSessionFromCreatedSession(created.session, targetStudyMinutes));
      await startRecorderForSession({
        session: created.session,
        segmentIndex: 0,
        chunkIndex: 0,
        baseStudySec: 0,
      });
    } catch (error) {
      const errorMessage = friendlyFetchError(error, "録画開始に失敗しました。");
      setMessage(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleResume() {
    if (!resumableSession) {
      return;
    }

    setIsBusy(true);
    setMessage(null);
    try {
      const response = await postJson<ResumeResponse>(
        `/api/sessions/${resumableSession.id}/resume`,
        {},
      );
      await uploadPendingChunks(resumableSession.id);
      const baseStudySec = completedSegmentStudySec(resumableSession);
      await startRecorderForSession({
        session: resumableSession,
        segmentIndex: response.segmentIndex,
        chunkIndex: 0,
        baseStudySec,
      });
      setResumableSession(null);
      setActiveSessionState(null);
    } catch (error) {
      const errorMessage = friendlyFetchError(error, "再開に失敗しました。");
      setMessage(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDiscardResume() {
    const session = resumableSession;
    if (session) {
      await fetch(`/api/sessions/${session.id}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "manual_pause",
          uploadStatus: pendingUploadCount > 0 ? "offline_pending" : "uploaded",
        }),
      });
    }
    clearActiveSession();
    setResumableSession(null);
    setActiveSessionState(null);
  }

  async function handleToggleBreak() {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    setIsBusy(true);
    try {
      if (isBreakActive) {
        await postJson<{ ok: true }>(`/api/sessions/${session.id}/break/end`, {});
        if (breakStartedAtRef.current !== null) {
          accumulatedBreakSecRef.current += Math.floor(
            (Date.now() - breakStartedAtRef.current) / 1000,
          );
        }
        breakStartedAtRef.current = null;
        setIsBreakActive(false);
        updateBreakState({
          isBreakActive: false,
          breakStartedAtMs: null,
          accumulatedBreakSec: accumulatedBreakSecRef.current,
        });
      } else {
        await postJson<{ ok: true }>(`/api/sessions/${session.id}/break/start`, {});
        breakStartedAtRef.current = Date.now();
        setIsBreakActive(true);
        updateBreakState({
          isBreakActive: true,
          breakStartedAtMs: breakStartedAtRef.current,
          accumulatedBreakSec: accumulatedBreakSecRef.current,
        });
      }
      refreshActualStudySec();
    } catch (error) {
      setMessage(friendlyFetchError(error, "休憩状態の更新に失敗しました。"));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStop() {
    setIsBusy(true);
    setMessage("最後のchunkを保存しています...");
    try {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (chunkTimerRef.current) {
        clearTimeout(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }
      shouldContinueRecordingRef.current = false;

      await stopCurrentRecorder();

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      await Promise.all(uploadPromisesRef.current);
      const session = sessionRef.current;
      if (session) {
        await uploadPendingChunks(session.id);
        await refreshPendingCount(session.id);
      }
      if (successfulChunkCountRef.current === 0) {
        throw new Error(
          "録画chunkがアップロードされませんでした。数秒以上録画してから停止してください。",
        );
      }
      setIsBreakActive(false);
      refreshActualStudySec();
      setPhase("review");
      setMessage(null);
    } catch (error) {
      const errorMessage = friendlyFetchError(error, "停止処理に失敗しました。");
      if (recorderRef.current?.state === "inactive" && successfulChunkCountRef.current === 0) {
        sessionRef.current = null;
        recorderRef.current = null;
        setPhase("setup");
      }
      setMessage(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleFinish() {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    const pending = await listPendingChunks(session.id);
    if (pending.length > 0) {
      setPendingUploadCount(pending.length);
      return;
    }

    setIsBusy(true);
    setPhase("processing");
    setMessage("タイムラプスを生成しています。長めの録画では数分かかります。");
    try {
      if (successfulChunkCountRef.current === 0) {
        throw new Error("録画chunkがないためタイムラプスを生成できません。");
      }
      await postJson<SessionResponse>(`/api/sessions/${session.id}/finish`, {
        studyContent,
        quality,
        reflectionNote,
      });
      clearActiveSession();
      const processResponse = await fetch(`/api/sessions/${session.id}/process`, {
        method: "POST",
      });
      if (!processResponse.ok) {
        const body = (await processResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "タイムラプス生成を開始できませんでした。");
      }
      router.push(`/sessions/${session.id}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "セッション保存に失敗しました。";
      setMessage(errorMessage);
      setPhase("review");
    } finally {
      setIsBusy(false);
    }
  }

  if (phase === "recording") {
    return (
      <>
        <RecordingStatusPanel
          actualStudySec={actualStudySec}
          targetStudySec={targetStudyMinutes * 60}
          isBreakActive={isBreakActive}
          isBusy={isBusy}
          isOnline={online}
          pendingUploadCount={pendingUploadCount}
          onToggleBreak={handleToggleBreak}
          onStop={handleStop}
        />
        {message ? <p className="mt-4 text-sm text-red-700">{message}</p> : null}
        <SmallCameraPreview videoRef={previewRef} />
      </>
    );
  }

  if (phase === "review" || phase === "processing") {
    const hasPendingUploads = pendingUploadCount > 0;

    return (
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="mb-6">
          <p className="text-sm text-zinc-500">実勉強時間</p>
          <p className="mt-1 text-3xl font-semibold">{formatDuration(actualStudySec)}</p>
        </div>
        <div className="space-y-5">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">勉強内容</span>
            <input
              value={studyContent}
              onChange={(event) => setStudyContent(event.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
              placeholder="例: 英単語、数学、資格試験"
            />
          </label>
          <div>
            <p className="mb-2 text-sm font-medium text-zinc-700">勉強クオリティ</p>
            <QualitySelector value={quality} onChange={setQuality} />
          </div>
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">メモ</span>
            <textarea
              value={reflectionNote}
              onChange={(event) => setReflectionNote(event.target.value)}
              className="mt-2 min-h-28 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
          <button
            type="button"
            disabled={isBusy || studyContent.trim().length === 0 || hasPendingUploads}
            onClick={handleFinish}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            <Save size={18} />
            保存してタイムラプス生成
          </button>
          {message ? <p className="text-sm text-zinc-600">{message}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6">
      {resumableSession ? (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="font-semibold text-emerald-950">前回のセッションが見つかりました</p>
          <p className="mt-2 text-sm text-emerald-900">
            {formatShortDate(resumableSession.startedAt)} 開始の録画を新しい区間として再開できます。
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleResume}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
            >
              <Play size={18} />
              再開する
            </button>
            <button
              type="button"
              onClick={handleDiscardResume}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-white px-4 py-2 text-emerald-900 disabled:opacity-50"
            >
              <X size={18} />
              破棄する
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-5 md:grid-cols-2">
        <StudyMinutesControl
          label="目標勉強時間（分）"
          value={targetStudyMinutes}
          onChange={setTargetStudyMinutes}
        />
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <p className="text-sm font-medium text-zinc-700">タイムラプス速度</p>
          <p className="mt-2 text-sm text-zinc-600">
            終了時の実勉強時間で自動決定します。45分未満は30x、45分以上2時間未満は60x、2時間以上は120xです。
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={isBusy || targetStudyMinutes <= 0}
        onClick={handleStart}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        <Play size={18} />
        勉強開始
      </button>
      {message ? <p className="mt-4 text-sm text-red-700">{message}</p> : null}
    </section>
  );
}
