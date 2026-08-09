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

/** "SMSA - 24/08/2026" — carrier plus the day the batch was packed. */
export function folderName(carrier: string | undefined, when: Date): string {
  const dd = String(when.getDate()).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const yyyy = when.getFullYear();
  return `${carrier?.trim() || "Orders"} - ${dd}/${mm}/${yyyy}`;
}
