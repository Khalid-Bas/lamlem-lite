"use client";

import type { Product } from "./catalog-types.ts";
import { DEFAULT_CATALOG } from "./catalog-default.ts";

/**
 * Where the product list comes from.
 *
 * The merchant's own list is baked in, so a batch needs only the two PDFs and
 * photos appear with no file to pick. It changes a few times a year at most,
 * and re-uploading it before every batch was friction with no payoff. An
 * updated list can still be loaded on the device when something does change.
 */

const KEY = "lamlem.catalog.v1";

export interface StoredCatalog {
  products: Product[];
  fileName: string;
  savedAt: string;
}

export function loadStoredCatalog(): StoredCatalog | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCatalog;
    return parsed?.products?.length ? parsed : null;
  } catch {
    return null;
  }
}

/** The list to link a batch against: the uploaded one, else the built-in. */
export function activeCatalog(): Product[] {
  return loadStoredCatalog()?.products ?? DEFAULT_CATALOG;
}

export function saveCatalog(products: Product[], fileName: string): StoredCatalog {
  const stored: StoredCatalog = { products, fileName, savedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A full quota must not lose the parsed list for this session.
  }
  return stored;
}

export function clearCatalog(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const BUILT_IN_CATALOG = DEFAULT_CATALOG;
