import { foldArabic } from "./arabic.ts";
import type { Product } from "./catalog-types.ts";

/**
 * Repairs variant text that the PDF font could not fully encode.
 *
 * Salla's invoice font maps some Arabic ligatures to glyphs with no ToUnicode
 * entry, so pdf.js yields U+FFFD in their place: "نوع الحليب م�وب اوت�" for
 * "نوع الحليب مشروب اوتلي". The characters are simply not recoverable from the
 * PDF — but the catalog already knows every legal value for that product, so
 * the damaged string only has to identify which one.
 *
 * Each marker is treated as a wildcard over one or more characters. When
 * several values still fit, the shortest wins: a marker almost always stands
 * for a single glyph (often a two-character ligature), so the candidate that
 * hides the fewest characters behind each marker is the likeliest reading.
 */

const MARKER = "�";

/** Strips spaces and orthographic variation so only letter identity matters. */
function squash(s: string): string {
  return foldArabic(s).replace(/\s+/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a pattern from damaged text: literal runs must match exactly, each run
 * of markers matches one or more unknown characters.
 */
function toPattern(damaged: string): RegExp | null {
  const squashed = squash(damaged).replace(/�+/g, MARKER);
  if (!squashed.includes(MARKER)) return null;
  const body = squashed
    .split(MARKER)
    .map(escapeRegExp)
    .join(".+?");
  return new RegExp(`^${body}$`);
}

export interface ResolvedOption {
  /** Display text, e.g. "نوع الحليب: مشروب اوتلي". */
  text: string;
  /** True when the catalog supplied the value rather than the PDF. */
  repaired: boolean;
}

/**
 * Resolves an order line's raw option text against a product's known variants.
 * Returns undefined when there is nothing sensible to show.
 */
export function resolveOption(
  rawOptionText: string | undefined,
  product: Product | undefined,
): ResolvedOption | undefined {
  if (!rawOptionText) return undefined;

  const clean = (s: string) =>
    s.replace(/�/g, "").replace(/\s{2,}/g, " ").trim();

  const variants = product?.variants ?? [];
  if (variants.length === 0) {
    const t = clean(rawOptionText);
    return t ? { text: t, repaired: false } : undefined;
  }

  const group = variants[0].groupName;

  // Undamaged text: match a variant directly so the spelling is the catalog's.
  if (!rawOptionText.includes(MARKER)) {
    const target = squash(rawOptionText);
    const exact = variants.find(
      (v) => target.includes(squash(v.value)) || squash(v.value) === target,
    );
    const text = exact ? `${group}: ${exact.value}` : clean(rawOptionText);
    return { text, repaired: Boolean(exact) };
  }

  const pattern = toPattern(rawOptionText);
  if (pattern) {
    // Candidates are matched with the group name included, because the damaged
    // string carries it too ("نوع الحليب م�وب اوت�").
    const fits = variants
      .filter((v) => pattern.test(squash(`${group} ${v.value}`)))
      .sort((a, b) => a.value.length - b.value.length);

    if (fits.length > 0) {
      return { text: `${group}: ${fits[0].value}`, repaired: true };
    }

    // Fall back to matching the value alone, in case the group name is absent.
    const valueOnly = variants
      .filter((v) => pattern.test(squash(v.value)))
      .sort((a, b) => a.value.length - b.value.length);
    if (valueOnly.length > 0) {
      return { text: `${group}: ${valueOnly[0].value}`, repaired: true };
    }
  }

  // Nothing matched: show what we have rather than inventing a value, and let
  // the caller flag it as unverified.
  const t = clean(rawOptionText);
  return t ? { text: t, repaired: false } : undefined;
}
