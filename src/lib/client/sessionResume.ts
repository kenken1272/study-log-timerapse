"use client";

import type { InterruptionReason } from "@/lib/sessions/types";

const ACTIVE_SESSION_KEY = "study-timelapse.active-session";

export type ActiveSessionState = {
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
  startedAtMs: number;
  targetStudyMinutes: number;
  speed: 30 | 60 | 120 | null;
  isBreakActive: boolean;
  breakStartedAtMs: number | null;
  accumulatedBreakSec: number;
  interruptedReason: InterruptionReason | null;
};

export function saveActiveSession(state: ActiveSessionState): void {
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(state));
}

export function loadActiveSession(): ActiveSessionState | null {
  const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ActiveSessionState>;
    if (typeof parsed.sessionId !== "string") {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      segmentIndex: parsed.segmentIndex ?? 0,
      chunkIndex: parsed.chunkIndex ?? 0,
      startedAtMs: parsed.startedAtMs ?? Date.now(),
      targetStudyMinutes: parsed.targetStudyMinutes ?? 60,
      speed: parsed.speed ?? null,
      isBreakActive: parsed.isBreakActive ?? false,
      breakStartedAtMs: parsed.breakStartedAtMs ?? null,
      accumulatedBreakSec: parsed.accumulatedBreakSec ?? 0,
      interruptedReason: parsed.interruptedReason ?? null,
    };
  } catch {
    return null;
  }
}

export function clearActiveSession(): void {
  localStorage.removeItem(ACTIVE_SESSION_KEY);
}

export function markInterrupted(reason: InterruptionReason): void {
  const state = loadActiveSession();
  if (!state) {
    return;
  }

  saveActiveSession({ ...state, interruptedReason: reason });
}

export function updateChunkIndex(chunkIndex: number): void {
  const state = loadActiveSession();
  if (!state) {
    return;
  }

  saveActiveSession({ ...state, chunkIndex });
}

export function updateBreakState(input: {
  isBreakActive: boolean;
  breakStartedAtMs: number | null;
  accumulatedBreakSec: number;
}): void {
  const state = loadActiveSession();
  if (!state) {
    return;
  }

  saveActiveSession({ ...state, ...input });
}
