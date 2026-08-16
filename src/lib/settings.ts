"use client";

/**
 * User preferences, persisted on the device.
 *
 * localStorage rather than IndexedDB: these are a handful of booleans read
 * synchronously during the first render, and a "دفعة جديدة" must not wipe them
 * the way it wipes the batch.
 */

export type VideoQuality = "high" | "medium" | "low";

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
  // The point of the recording is being able to read a label in it, so the
  // default favours legibility over file size.
  videoQuality: "high",
};

const KEY = "lamlem.settings.v1";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
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

/** Capture constraints and bitrate for each quality step. */
export const QUALITY: Record<
  VideoQuality,
  { width: number; height: number; bitrate: number; label: string; note: string }
> = {
  high: {
    width: 1920,
    height: 1080,
    bitrate: 6_000_000,
    label: "عالية (1080p)",
    note: "أوضح للنصوص على البوليصة · ~٤٥ ميجابايت للدقيقة",
  },
  medium: {
    width: 1280,
    height: 720,
    bitrate: 3_000_000,
    label: "متوسطة (720p)",
    note: "~٢٢ ميجابايت للدقيقة",
  },
  low: {
    width: 854,
    height: 480,
    bitrate: 1_200_000,
    label: "منخفضة (480p)",
    note: "الأصغر حجمًا · ~٩ ميجابايت للدقيقة",
  },
};
