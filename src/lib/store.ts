"use client";

/**
 * On-device storage. No server, no account, no network.
 *
 * Videos are the reason this is IndexedDB rather than localStorage: a few
 * minutes of 720p is megabytes, far past the ~5 MB string quota, and Blobs are
 * stored natively here without base64 inflating them by a third.
 */

import type { Batch, PackRecord } from "./types.ts";

const DB_NAME = "lamlem-lite";
const DB_VERSION = 1;
const STORE_STATE = "state";
const STORE_VIDEOS = "videos";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) db.createObjectStore(STORE_VIDEOS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const saveBatch = (b: Batch) =>
  tx(STORE_STATE, "readwrite", (s) => s.put(b, "batch"));

export const loadBatch = () =>
  tx<Batch | undefined>(STORE_STATE, "readonly", (s) => s.get("batch"));

export const clearAll = async () => {
  await tx(STORE_STATE, "readwrite", (s) => s.clear());
  await tx(STORE_VIDEOS, "readwrite", (s) => s.clear());
};

export const saveVideo = (orderId: string, blob: Blob) =>
  tx(STORE_VIDEOS, "readwrite", (s) => s.put(blob, orderId));

export const loadVideo = (orderId: string) =>
  tx<Blob | undefined>(STORE_VIDEOS, "readonly", (s) => s.get(orderId));

export const deleteVideo = (orderId: string) =>
  tx(STORE_VIDEOS, "readwrite", (s) => s.delete(orderId));

/** Rough bytes used, so the packer can tell when to export and clear. */
export async function usage(): Promise<{ used: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { used: e.usage ?? 0, quota: e.quota ?? 0 };
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Records are small; kept on the batch so one write persists everything. */
export function upsertRecord(batch: Batch, rec: PackRecord): Batch {
  const rest = batch.records.filter((r) => r.orderId !== rec.orderId);
  return { ...batch, records: [...rest, rec] };
}
