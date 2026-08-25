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
  /**
   * Products that get a continuous tone while being packed, and a mandatory
   * confirm tap. For items that are easy to grab by mistake.
   */
  alertProducts: string[];
}

export const DEFAULTS: Settings = {
  voice: true,
  verifyAfterPack: true,
  // The setting that was confirmed legible on a real label. Dropping the frame
  // rate to save space looked worse in practice than the theory predicted, so
  // full quality is the default and size is traded on bitrate alone.
  videoQuality: "high",
  alertProducts: [],
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
 * All presets record at 1080p24. An earlier attempt saved space by halving the
 * frame rate — on the theory that fewer frames leaves more bits for each one —
 * but on a real device the result looked clearly worse, so frame rate is left
 * alone and size is traded on bitrate only.
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
    bitrate: 6_000_000,
    label: "أعلى وضوح (1080p) — موصى بها",
    note: "أوضح للنصوص على البوليصة · ~٤٥ ميجابايت للدقيقة",
  },
  balanced: {
    width: 1920,
    height: 1080,
    fps: 24,
    bitrate: 3_500_000,
    label: "متوازنة (1080p)",
    note: "نفس الدقة والحركة بحجم أقل · ~٢٦ ميجابايت للدقيقة",
  },
  saver: {
    width: 1280,
    height: 720,
    fps: 24,
    bitrate: 2_000_000,
    label: "موفّرة (720p)",
    note: "الأصغر حجمًا · ~١٥ ميجابايت للدقيقة",
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
