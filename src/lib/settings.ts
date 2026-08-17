"use client";

/**
 * User preferences, persisted on the device.
 *
 * localStorage rather than IndexedDB: these are a handful of booleans read
 * synchronously during the first render, and a "دفعة جديدة" must not wipe them
 * the way it wipes the batch.
 */

export type VideoQuality = "high" | "balanced" | "saver";

export interface Settings {
  /** Read the order's contents aloud when a label scans. */
  voice: boolean;
  /** After finishing an order, ask for a confirming re-scan. */
  verifyAfterPack: boolean;
  videoQuality: VideoQuality;
}

export const DEFAULTS: Settings = {
  voice: true,
  verifyAfterPack: true,
  // Full 1080p, but at a frame rate and bitrate tuned for a mostly-static
  // bench: text stays readable at roughly half the size of the "high" preset.
  videoQuality: "balanced",
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
 * Resolution is what makes printed text legible, so the balanced preset keeps
 * the full 1920×1080 and saves space on the other two axes instead.
 *
 * Frame rate is the useful lever: at a fixed bitrate, halving the frame rate
 * roughly doubles the bits available to each frame, so 15fps at 2.5 Mbps holds
 * detail better per frame than 24fps at the same bitrate — while producing a
 * far smaller file. Packing is slow, deliberate movement; 15fps is plenty.
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
  high: {
    width: 1920,
    height: 1080,
    fps: 24,
    bitrate: 5_000_000,
    label: "أعلى وضوح (1080p)",
    note: "أنعم حركة وأدق تفاصيل · ~٣٧ ميجابايت للدقيقة",
  },
  balanced: {
    width: 1920,
    height: 1080,
    fps: 15,
    bitrate: 2_500_000,
    label: "متوازنة (1080p) — موصى بها",
    note: "نفس الوضوح للنصوص بنصف الحجم · ~١٩ ميجابايت للدقيقة",
  },
  saver: {
    width: 1280,
    height: 720,
    fps: 15,
    bitrate: 1_200_000,
    label: "موفّرة (720p)",
    note: "الأصغر حجمًا · ~٩ ميجابايت للدقيقة",
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
