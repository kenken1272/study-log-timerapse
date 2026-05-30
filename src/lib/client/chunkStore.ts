"use client";

export type StoredChunkUploadStatus = "pending" | "uploading" | "uploaded" | "failed";

export type StoredChunk = {
  id: string;
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
  blob: Blob;
  sizeBytes: number;
  contentType: string;
  createdAtMs: number;
  uploadStatus: StoredChunkUploadStatus;
  objectPath: string | null;
  errorMessage: string | null;
};

const DB_NAME = "study-timelapse";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("uploadStatus", "uploadStatus", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = callback(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      }),
  );
}

export function chunkId(sessionId: string, segmentIndex: number, chunkIndex: number): string {
  return `${sessionId}:${segmentIndex}:${chunkIndex}`;
}

export async function saveChunk(input: Omit<StoredChunk, "id" | "createdAtMs">): Promise<StoredChunk> {
  const chunk: StoredChunk = {
    ...input,
    id: chunkId(input.sessionId, input.segmentIndex, input.chunkIndex),
    createdAtMs: Date.now(),
  };
  await withStore("readwrite", (store) => store.put(chunk));

  return chunk;
}

export async function updateStoredChunk(
  id: string,
  patch: Partial<Pick<StoredChunk, "uploadStatus" | "objectPath" | "errorMessage">>,
): Promise<void> {
  const existing = await getStoredChunk(id);
  if (!existing) {
    return;
  }

  await withStore("readwrite", (store) => store.put({ ...existing, ...patch }));
}

export async function getStoredChunk(id: string): Promise<StoredChunk | null> {
  const result = await withStore<StoredChunk | undefined>("readonly", (store) => store.get(id));
  return result ?? null;
}

export async function deleteStoredChunk(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export async function listPendingChunks(sessionId?: string): Promise<StoredChunk[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const chunks = (request.result as StoredChunk[])
        .filter((chunk) => {
          const matchesSession = sessionId ? chunk.sessionId === sessionId : true;
          return (
            matchesSession &&
            (chunk.uploadStatus === "pending" ||
              chunk.uploadStatus === "failed" ||
              chunk.uploadStatus === "uploading")
          );
        })
        .sort((left, right) => left.segmentIndex - right.segmentIndex || left.chunkIndex - right.chunkIndex);
      resolve(chunks);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
