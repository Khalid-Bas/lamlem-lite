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

/**
 * Config comes from the app's own settings first, falling back to build-time
 * variables. Pasting the id in the app means no redeploy to change it.
 */
export function driveConfigured(clientId?: string): boolean {
  return Boolean(clientId?.trim() || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);
}

function resolveClientId(clientId?: string): string | undefined {
  return clientId?.trim() || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || undefined;
}

/**
 * The Drive folder uploads are filed under, if one was configured.
 *
 * Accepts either a bare id or a pasted folder URL, since the share link is
 * what a person actually has to hand.
 */
export function targetFolderId(configured?: string): string | undefined {
  const raw = (configured?.trim() || process.env.NEXT_PUBLIC_DRIVE_FOLDER_ID || "").trim();
  if (!raw) return undefined;
  // Accept a pasted share link as well as a bare id — the link is what a
  // person actually has to hand.
  const fromUrl = raw.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1];
  return fromUrl ?? raw.split(/[?&#]/)[0];
}

/** "26 Aug 2026" — the day the batch was filmed. */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function dayFolderName(when: Date): string {
  return `${when.getDate()} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`;
}

/**
 * The date as a person says it out loud — "10 Sep".
 *
 * Used in file names, where the year is noise: everything in a batch is from
 * the same week, and the short form leaves room for the figures that actually
 * tell one stocktake from another.
 */
export function shortDay(when: Date): string {
  return `${when.getDate()} ${MONTHS[when.getMonth()]}`;
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
        error_callback?: (e: { type?: string }) => void;
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
export async function getAccessToken(configuredClientId?: string): Promise<string> {
  const clientId = resolveClientId(configuredClientId);
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
      error_callback: (err: { type?: string }) => {
        // Popup blocked or dismissed: say which, rather than hanging forever.
        reject(
          new Error(
            err?.type === "popup_closed"
              ? "أُغلقت نافذة Google قبل إتمام الإذن"
              : "تعذّر فتح نافذة Google — اسمح بالنوافذ المنبثقة لهذا الموقع",
          ),
        );
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

/**
 * Creates a folder, reusing one of the same name if this app made it before.
 *
 * With `parentId` set the folder is created inside it and only matched there,
 * so a dated folder in one parent never collides with the same date elsewhere.
 */
export async function ensureFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const clauses = [
    `name='${name.replace(/'/g, "\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(clauses.join(" and "));

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
        ...(parentId ? { parents: [parentId] } : {}),
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
 * Names a clip after every order it contains: "278290423 - 278307194 - …".
 *
 * One recording can cover a whole group session, and the packer needs to find
 * it later by any of its order numbers — so all of them go in the name rather
 * than just the first. Long sessions are trimmed with a count, because most
 * filesystems refuse names beyond 255 characters.
 */
export function clipFileName(
  orderNumbers: string[],
  carrier = "",
  limit = 180,
): string {
  if (orderNumbers.length === 0) return "unnamed";
  // The carrier tag leads, so a folder of clips sorts and reads by courier.
  const prefix = carrier ? `${carrier} - ` : "";
  const joined = prefix + orderNumbers.join(" - ");
  if (joined.length <= limit) return safeFileName(joined, limit);

  // Reserve room for the "+ N طلب" tail before filling, or the tail itself
  // gets truncated away and the name silently claims to list every order.
  const tailFor = (n: number) => ` + ${n} طلب`;
  const budget = limit - tailFor(orderNumbers.length).length - prefix.length;

  const kept: string[] = [];
  let len = 0;
  for (const n of orderNumbers) {
    const add = kept.length === 0 ? n.length : n.length + 3;
    if (len + add > budget) break;
    kept.push(n);
    len += add;
  }
  const rest = orderNumbers.length - kept.length;
  return safeFileName(`${prefix}${kept.join(" - ")}${tailFor(rest)}`, limit);
}

/**
 * Makes a string safe to use as a file name.
 *
 * Drive itself tolerates most characters, but these files get downloaded onto
 * Windows and macOS where \ / : * ? " < > | are illegal — a name containing
 * one can fail to save with no useful error.
 */
export function safeFileName(s: string, max = 120): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  return (cleaned || "unnamed").slice(0, max);
}

/* ══════════════ sharing without any setup ══════════════ */

/**
 * Hands finished clips to Android's share sheet, where Drive is one of the
 * targets — using the Google account the phone is already signed in to.
 *
 * This is the zero-setup path. A true background upload into a named Drive
 * folder is only possible through the Drive API, which requires an OAuth client
 * registered to this exact origin; there is no way for the app to reach a
 * user's Drive without one. The share sheet gets to the same place in two taps
 * and needs nothing configured.
 */
export function canShareFiles(files: File[]): boolean {
  if (typeof navigator === "undefined") return false;
  const n = navigator as Navigator & {
    canShare?: (d: { files?: File[] }) => boolean;
    share?: unknown;
  };
  if (!n.share || !n.canShare) return false;
  try {
    return n.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * How many files to hand the share sheet at once.
 *
 * Chrome on Android quietly refuses a large share: `canShare` returns false
 * once the set is past its limit, and forty photos hit it every time while ten
 * went through. There is no way to raise the ceiling from a web page, so the
 * set is walked through in batches instead, each one its own tap. The cap is
 * on total bytes as well as on count, because the real limit is payload size
 * and full-resolution photos vary enormously.
 */
export const SHARE_MAX_FILES = 10;
export const SHARE_MAX_BYTES = 45 * 1024 * 1024;

/** Splits files into sets the share sheet will actually accept. */
export function shareBatches(
  files: File[],
  maxFiles = SHARE_MAX_FILES,
  maxBytes = SHARE_MAX_BYTES,
): File[][] {
  const out: File[][] = [];
  let current: File[] = [];
  let bytes = 0;
  for (const f of files) {
    // A single file over the cap still goes on its own — refusing it outright
    // would silently drop a photo the packer believes they have shared.
    if (current.length > 0 && (current.length >= maxFiles || bytes + f.size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.size;
  }
  if (current.length) out.push(current);
  return out;
}

export async function shareFiles(files: File[], title: string): Promise<void> {
  const n = navigator as Navigator & {
    share: (d: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  };
  await n.share({ files, title, text: title });
}
