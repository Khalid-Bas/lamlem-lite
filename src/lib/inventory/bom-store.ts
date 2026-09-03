"use client";

import type { Bom } from "./bom.ts";
import { DEFAULT_BOM } from "./bom-default.ts";

/**
 * Where the consumption matrix comes from.
 *
 * The merchant's own sheet is baked in, so جرد الكميات works on a fresh phone
 * with nothing to set up. Recipes change though — a bundle gains a sticker, a
 * cup design is retired — so an updated sheet can be uploaded and is kept on
 * the device, next to the other settings rather than inside the batch, because
 * it outlives «دفعة جديدة».
 */

const KEY = "lamlem.bom.v1";

export interface StoredBom {
  bom: Bom;
  fileName: string;
  savedAt: string;
}

export function loadStoredBom(): StoredBom | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBom;
    return parsed?.bom?.rows?.length ? parsed : null;
  } catch {
    return null;
  }
}

/** The matrix to cost a batch against: the uploaded one, else the built-in. */
export function activeBom(): Bom {
  return loadStoredBom()?.bom ?? DEFAULT_BOM;
}

export function saveBom(bom: Bom, fileName: string): StoredBom {
  const stored: StoredBom = { bom, fileName, savedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A full quota must not lose the parsed matrix for this session.
  }
  return stored;
}

export function clearBom(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const BUILT_IN_BOM = DEFAULT_BOM;
