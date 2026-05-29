"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Save } from "lucide-react";
import type { JsonStudySession, StudyQuality } from "@/lib/sessions/types";
import { formatDuration } from "@/lib/time/format";
import { QualitySelector } from "@/components/QualitySelector";
import { RecordingStatusPanel } from "@/components/RecordingStatusPanel";
import { SmallCameraPreview } from "@/components/SmallCameraPreview";

type SessionResponse = {
  session: JsonStudySession;
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
  const response = await fetch(url, {
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

export function CameraRecorder() {
  const router = useRouter();
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<JsonStudySession | null>(null);
  const uploadPromisesRef = useRef<Promise<void>[]>([]);
  const successfulChunkCountRef = useRef(0);
  const chunkIndexRef = useRef(0);
  const startedAtRef = useRef(0);
  const accumulatedBreakSecRef = useRef(0);
  const breakStartedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [targetStudyMinutes, setTargetStudyMinutes] = useState(60);
  const [phase, setPhase] = useState<RecorderPhase>("setup");
  const [actualStudySec, setActualStudySec] = useState(0);
  const [isBreakActive, setIsBreakActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [studyContent, setStudyContent] = useState("");
  const [quality, setQuality] = useState<StudyQuality>(3);
  const [reflectionNote, setReflectionNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
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

  function refreshActualStudySec() {
    if (startedAtRef.current === 0) {
      return;
    }

    const elapsedSec = Math.floor((Date.now() - startedAtRef.current) / 1000);
    const activeBreakSec =
      breakStartedAtRef.current === null
        ? 0
        : Math.floor((Date.now() - breakStartedAtRef.current) / 1000);
    setActualStudySec(Math.max(0, elapsedSec - accumulatedBreakSecRef.current - activeBreakSec));
  }

  async function uploadChunk(blob: Blob, index: number, sessionId: string, contentType: string) {
    if (blob.size === 0) {
      return;
    }

    const uploadData = await postJson<UploadUrlResponse>(
      `/api/sessions/${sessionId}/upload-url`,
      {
        index,
        contentType,
      },
    );
    const uploadResponse = await fetch(uploadData.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });
    if (!uploadResponse.ok) {
      throw new Error("GCS chunk upload failed.");
    }

    await postJson<{ ok: true }>(`/api/sessions/${sessionId}/chunk-complete`, {
      index,
      objectPath: uploadData.objectPath,
      sizeBytes: blob.size,
    });
  }

  async function handleStart() {
    setIsBusy(true);
    setMessage(null);
    try {
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

      const created = await postJson<SessionResponse>("/api/sessions", {
        targetStudyMinutes,
      });
      sessionRef.current = created.session;
      chunkIndexRef.current = 0;
      successfulChunkCountRef.current = 0;
      uploadPromisesRef.current = [];
      startedAtRef.current = Date.now();
      accumulatedBreakSecRef.current = 0;
      breakStartedAtRef.current = null;

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || !sessionRef.current) {
          return;
        }
        const index = chunkIndexRef.current;
        chunkIndexRef.current += 1;
        const promise = uploadChunk(
          event.data,
          index,
          sessionRef.current.id,
          event.data.type || mimeType,
        );
        const trackedPromise = promise
          .then(() => {
            successfulChunkCountRef.current += 1;
          })
          .catch((error: unknown) => {
            const errorMessage =
              error instanceof Error ? error.message : "chunk upload failed.";
            setMessage(errorMessage);
            throw error;
          });
        uploadPromisesRef.current.push(trackedPromise);
      };
      recorder.start(60_000);
      timerRef.current = setInterval(refreshActualStudySec, 1000);
      setPhase("recording");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "録画開始に失敗しました。";
      setMessage(errorMessage);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleToggleBreak() {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    setIsBusy(true);
    try {
      if (isBreakActive) {
        await fetch(`/api/sessions/${session.id}/break/end`, { method: "POST" });
        if (breakStartedAtRef.current !== null) {
          accumulatedBreakSecRef.current += Math.floor(
            (Date.now() - breakStartedAtRef.current) / 1000,
          );
        }
        breakStartedAtRef.current = null;
        setIsBreakActive(false);
      } else {
        await fetch(`/api/sessions/${session.id}/break/start`, { method: "POST" });
        breakStartedAtRef.current = Date.now();
        setIsBreakActive(true);
      }
      refreshActualStudySec();
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStop() {
    setIsBusy(true);
    setMessage("最後のchunkをアップロードしています...");
    try {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.requestData();
          recorder.stop();
        });
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      await Promise.all(uploadPromisesRef.current);
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
      const errorMessage = error instanceof Error ? error.message : "停止処理に失敗しました。";
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
      await fetch(`/api/sessions/${session.id}/process`, { method: "POST" });
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
          onToggleBreak={handleToggleBreak}
          onStop={handleStop}
        />
        {message ? <p className="mt-4 text-sm text-red-700">{message}</p> : null}
        <SmallCameraPreview videoRef={previewRef} />
      </>
    );
  }

  if (phase === "review" || phase === "processing") {
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
            disabled={isBusy || studyContent.trim().length === 0}
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
      <div className="grid gap-5 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-zinc-700">目標勉強時間（分）</span>
          <input
            type="number"
            min={1}
            value={targetStudyMinutes}
            onChange={(event) => setTargetStudyMinutes(Number(event.target.value))}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 outline-none focus:border-emerald-500"
          />
        </label>
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
