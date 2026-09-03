"use client";

/**
 * User preferences, persisted on the device.
 *
 * localStorage rather than IndexedDB: these are a handful of booleans read
 * synchronously during the first render, and a "دفعة جديدة" must not wipe them
 * the way it wipes the batch.
 */

export type VideoQuality = "ultra" | "high" | "balanced" | "saver";

export interface Settings {
  /** Read the order's contents aloud when a label scans. */
  voice: boolean;
  /** After finishing an order, ask for a confirming re-scan. */
  verifyAfterPack: boolean;
  videoQuality: VideoQuality;
  /**
   * Google OAuth client id for direct Drive upload, pasted in the app rather
   * than baked in at build time — a build-time variable meant editing Vercel
   * and redeploying just to try a credential, which is a miserable loop.
   */
  driveClientId: string;
  /** Destination folder: a bare id or a pasted Drive folder URL. */
  driveFolderId: string;
}

export const DEFAULTS: Settings = {
  voice: true,
  verifyAfterPack: true,
  // The setting that was confirmed legible on a real label. Dropping the frame
  // rate to save space looked worse in practice than the theory predicted, so
  // full quality is the default and size is traded on bitrate alone.
  videoQuality: "high",
  driveClientId: "",
  driveFolderId: "",
};

const KEY = "lamlem.settings.v1";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...parsed,
      videoQuality: migrateQuality(parsed.videoQuality),
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or a full quota must never block packing.
  }
}

/**
 * Capture settings per quality step.
 *
 * Resolution is what makes small print on a shipping label readable, so the
 * top preset records 1440p — a modern Android flagship encodes it in hardware
 * without breaking a sweat, and it is a real step up from 1080p for text while
 * costing far less than 4K would.
 *
 * Frame rate stays at 30 across the board. An earlier attempt to save space by
 * halving it looked clearly worse on a real device, so size is traded on
 * bitrate and resolution only.
 */
export const QUALITY: Record<
  VideoQuality,
  {
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    label: string;
    note: string;
  }
> = {
  ultra: {
    width: 2560,
    height: 1440,
    fps: 30,
    bitrate: 9_000_000,
    label: "فائقة (1440p)",
    note: "أوضح ما يمكن لقراءة النصوص · ~٦٧ ميجابايت للدقيقة",
  },
  high: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 7_000_000,
    label: "عالية (1080p) — موصى بها",
    note: "واضحة للبوليصة بحجم معقول · ~٥٢ ميجابايت للدقيقة",
  },
  balanced: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 4_000_000,
    label: "متوازنة (1080p)",
    note: "نفس الدقة بحجم أقل · ~٣٠ ميجابايت للدقيقة",
  },
  saver: {
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_500_000,
    label: "موفّرة (720p)",
    note: "الأصغر حجمًا · ~١٩ ميجابايت للدقيقة",
  },
};

/** Old stored values from before the presets were retuned. */
const LEGACY: Record<string, VideoQuality> = {
  medium: "balanced",
  low: "saver",
};

export function migrateQuality(v: unknown): VideoQuality {
  if (typeof v !== "string") return DEFAULTS.videoQuality;
  if (v in QUALITY) return v as VideoQuality;
  return LEGACY[v] ?? DEFAULTS.videoQuality;
}
