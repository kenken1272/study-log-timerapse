"use client";

/**
 * Serialises chunk uploads within a session.
 *
 * Previously every 30-second chunk started its own PUT the moment the recorder
 * produced it, with no bound on concurrency. On a link slower than the capture
 * bitrate the in-flight PUTs accumulate, saturate the connection, and the
 * browser's per-host connection cap leaves the rest sitting in "Pending"
 * indefinitely — which is exactly the reported failure.
 *
 * One upload at a time makes the backlog visible and ordered instead of
 * invisible and chaotic. It does not create bandwidth: if uploads are slower
 * than capture, the queue still grows. It makes that condition observable.
 */

type QueueEntry = {
  chain: Promise<unknown>;
  depth: number;
};

const queues = new Map<string, QueueEntry>();

export function enqueueUpload<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const existing = queues.get(sessionId) ?? { chain: Promise.resolve(), depth: 0 };
  existing.depth += 1;

  // Chain onto the previous task regardless of whether it succeeded, so one
  // failure does not wedge the queue for the rest of the session.
  const run = existing.chain.then(task, task);

  const entry: QueueEntry = {
    chain: run.then(
      () => undefined,
      () => undefined,
    ),
    depth: existing.depth,
  };
  queues.set(sessionId, entry);

  return run.finally(() => {
    const current = queues.get(sessionId);
    if (current) {
      current.depth = Math.max(0, current.depth - 1);
    }
  });
}

export function queueDepth(sessionId: string): number {
  return queues.get(sessionId)?.depth ?? 0;
}

/**
 * Wait for a session's queue to drain, but never longer than `timeoutMs`.
 *
 * Stopping a recording used to `Promise.all` the upload promises, which waits
 * forever if any single PUT hangs — the user is left on a spinner with no way
 * out. Returns true if the queue drained, false if it timed out.
 */
export async function drainQueue(sessionId: string, timeoutMs: number): Promise<boolean> {
  const entry = queues.get(sessionId);
  if (!entry) {
    return true;
  }

  let timer: number | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = window.setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([entry.chain.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

export function resetQueue(sessionId: string): void {
  queues.delete(sessionId);
}
