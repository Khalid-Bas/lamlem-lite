"use client";

/**
 * Google Drive upload for finished batches.
 *
 * Uses Google Identity Services directly rather than a backend: there is no
 * server in this app, and the token never needs to outlive the tab. The scope
 * requested is `drive.file`, which only grants access to files this app itself
 * creates — it cannot read anything already in the account.
 *
 * Needs NEXT_PUBLIC_GOOGLE_CLIENT_ID to be set at build time; without it the
 * feature stays hidden rather than failing at the moment of use.
 */

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export function driveConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
  callback: (r: TokenResponse) => void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
      }): TokenClient;
    };
  };
}

let gisPromise: Promise<Gis> | null = null;

function loadGis(): Promise<Gis> {
  if (!gisPromise) {
    gisPromise = new Promise<Gis>((resolve, reject) => {
      const existing = (globalThis as unknown as { google?: Gis }).google;
      if (existing?.accounts?.oauth2) return resolve(existing);
      const s = document.createElement("script");
      s.src = GIS_SRC;
      s.async = true;
      s.onload = () => {
        const g = (globalThis as unknown as { google?: Gis }).google;
        g?.accounts?.oauth2
          ? resolve(g)
          : reject(new Error("تعذّر تحميل تسجيل الدخول من Google"));
      };
      s.onerror = () => reject(new Error("تعذّر الوصول إلى Google — تحقق من الإنترنت"));
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

/** Opens Google's consent popup and returns a short-lived access token. */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("لم يُضبط معرّف Google بعد");

  const gis = await loadGis();
  return new Promise<string>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (res) => {
        if (res.access_token) resolve(res.access_token);
        else reject(new Error(res.error ?? "لم يتم منح الإذن"));
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function driveFetch(
  token: string,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Creates a folder, reusing one of the same name if this app made it before. */
export async function ensureFolder(token: string, name: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const found = (await driveFetch(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
    { method: "GET" },
  )) as { files?: { id: string }[] };

  if (found.files?.length) return found.files[0].id;

  const created = (await driveFetch(
    token,
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
  )) as { id: string };
  return created.id;
}

/** Uploads one file into a folder. Multipart keeps it to a single request. */
export async function uploadFile(
  token: string,
  folderId: string,
  name: string,
  blob: Blob,
): Promise<void> {
  const boundary = `lamlem${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [folderId] });

  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);

  await driveFetch(
    token,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
}

/** Uploads a small text file, used for the batch manifest. */
export async function uploadText(
  token: string,
  folderId: string,
  name: string,
  text: string,
): Promise<void> {
  // The BOM makes Excel open the CSV as UTF-8 instead of mangling the Arabic.
  await uploadFile(
    token,
    folderId,
    name,
    new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }),
  );
}

/**
 * "SMSA - 24/08/2026" — carrier plus the day the batch was packed.
 *
 * Slashes are legal in Drive names (it has no path syntax), so the date is
 * kept in the readable form asked for.
 */
export function folderName(carrier: string | undefined, when: Date): string {
  const dd = String(when.getDate()).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const yyyy = when.getFullYear();
  return `${carrier?.trim() || "Orders"} - ${dd}/${mm}/${yyyy}`;
}

/**
 * Makes a string safe to use as a file name.
 *
 * Drive itself tolerates most characters, but these files get downloaded onto
 * Windows and macOS where `\ / : * ? " < > |` are illegal — a name containing
 * one can fail to save with no useful error.
 */
/**
 * Names a clip after every order it contains: "278290423 - 278307194 - …".
 *
 * One recording can cover a whole group session, and the packer needs to find
 * it later by any of its order numbers — so all of them go in the name rather
 * than just the first. Long sessions are trimmed with a count, because most
 * filesystems refuse names beyond 255 characters.
 */
export function clipFileName(orderNumbers: string[], limit = 180): string {
  if (orderNumbers.length === 0) return "unnamed";
  const joined = orderNumbers.join(" - ");
  if (joined.length <= limit) return safeFileName(joined, limit);

  // Reserve room for the "+ N طلب" tail before filling, or the tail itself
  // gets truncated away and the name silently claims to list every order.
  const tailFor = (n: number) => ` + ${n} طلب`;
  const budget = limit - tailFor(orderNumbers.length).length;

  const kept: string[] = [];
  let len = 0;
  for (const n of orderNumbers) {
    const add = kept.length === 0 ? n.length : n.length + 3;
    if (len + add > budget) break;
    kept.push(n);
    len += add;
  }
  const rest = orderNumbers.length - kept.length;
  return safeFileName(`${kept.join(" - ")}${tailFor(rest)}`, limit);
}

export function safeFileName(s: string, max = 120): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  return (cleaned || "unnamed").slice(0, max);
}
