"use client";

/**
 * User preferences, persisted on the device.
 *
 * localStorage rather than IndexedDB: these are a handful of booleans read
 * synchronously during the first render, and a "دفعة جديدة" must not wipe them
 * the way it wipes the batch.
 */

export type PhotoQuality = "ultra" | "high" | "balanced" | "saver";

/**
 * What a shipment costs us and what the customer was charged, per service.
 *
 * Kept as settings rather than constants because carrier tariffs are
 * renegotiated, and a figure baked into the bundle would mean a redeploy to
 * correct the profit sheet. Both are stated the way the merchant quotes them —
 * some tariffs include VAT, some do not — and converted where the maths needs
 * a net figure, so nobody has to do that conversion by hand.
 */
export interface ShipTariff {
  label: string;
  /** What the carrier bills us. */
  cost: number;
  costIncludesVat: boolean;
  /** What the customer paid for shipping, as shown in the store. */
  charged: number;
  chargedIncludesVat: boolean;
}

export type ShipService = "dn" | "smsaHome" | "smsaPickup";

export interface Settings {
  /** Read the order's contents aloud when a label scans. */
  voice: boolean;
  photoQuality: PhotoQuality;
  /** VAT rate as a percentage, for the profit sheet. */
  vatPercent: number;
  shipping: Record<ShipService, ShipTariff>;
  /**
   * Google OAuth client id for direct Drive upload, pasted in the app rather
   * than baked in at build time — a build-time variable meant editing Vercel
   * and redeploying just to try a credential, which is a miserable loop.
   */
  driveClientId: string;
  /** Destination folder: a bare id or a pasted Drive folder URL. */
  driveFolderId: string;
}

export const SHIPPING_DEFAULTS: Record<ShipService, ShipTariff> = {
  dn: {
    label: "دليفر ناو",
    cost: 14,
    costIncludesVat: false,
    charged: 22.98,
    chargedIncludesVat: true,
  },
  smsaHome: {
    label: "سمسا — توصيل منزلي",
    cost: 29,
    costIncludesVat: true,
    charged: 29.99,
    chargedIncludesVat: true,
  },
  smsaPickup: {
    label: "سمسا — استلام من الفرع",
    cost: 14,
    costIncludesVat: false,
    charged: 22.99,
    chargedIncludesVat: true,
  },
};

export const DEFAULTS: Settings = {
  voice: true,
  photoQuality: "high",
  vatPercent: 15,
  shipping: SHIPPING_DEFAULTS,
  driveClientId: "",
  driveFolderId: "",
};

const KEY = "lamlem.settings.v1";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { videoQuality?: unknown };
    return {
      ...DEFAULTS,
      ...parsed,
      // Merge per-service so a tariff added later is not missing on a phone
      // that stored the settings before it existed.
      shipping: {
        ...SHIPPING_DEFAULTS,
        ...(parsed.shipping ?? {}),
      },
      // Phones that used the app when it recorded video still hold the old key.
      photoQuality: migrateQuality(parsed.photoQuality ?? parsed.videoQuality),
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
 * Capture resolution per quality step.
 *
 * Resolution is what makes small print on a shipping label readable in the
 * photo, so the top preset asks for 1440p. It is a request, not a promise: a
 * phone that supports `ImageCapture` takes the shot at the sensor's own photo
 * resolution and this only governs the viewfinder and the fallback grab.
 */
export const QUALITY: Record<
  PhotoQuality,
  { width: number; height: number; label: string; note: string }
> = {
  ultra: {
    width: 2560,
    height: 1440,
    label: "فائقة (1440p)",
    note: "أوضح ما يمكن لقراءة النصوص في الصورة",
  },
  high: {
    width: 1920,
    height: 1080,
    label: "عالية (1080p) — موصى بها",
    note: "واضحة للبوليصة بحجم معقول",
  },
  balanced: {
    width: 1600,
    height: 900,
    label: "متوازنة (900p)",
    note: "صور أصغر حجمًا",
  },
  saver: {
    width: 1280,
    height: 720,
    label: "موفّرة (720p)",
    note: "الأصغر حجمًا",
  },
};

/** Old stored values from before the presets were retuned. */
const LEGACY: Record<string, PhotoQuality> = {
  medium: "balanced",
  low: "saver",
};

export function migrateQuality(v: unknown): PhotoQuality {
  if (typeof v !== "string") return DEFAULTS.photoQuality;
  if (v in QUALITY) return v as PhotoQuality;
  return LEGACY[v] ?? DEFAULTS.photoQuality;
}
