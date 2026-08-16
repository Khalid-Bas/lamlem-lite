import { foldArabic } from "./arabic.ts";
import type { Product, Variant } from "./catalog-types.ts";

/**
 * Repairs variant text that the PDF font could not fully encode.
 *
 * Salla's invoice font maps some Arabic ligatures to glyphs with no ToUnicode
 * entry, so pdf.js yields U+FFFD in their place: "نوع الحليب م�وب اوت�" for
 * "نوع الحليب مشروب اوتلي". The characters are not recoverable from the PDF —
 * but the catalog already knows every legal value, so the damaged string only
 * has to identify which one.
 *
 * Each marker is treated as a wildcard over one or more characters. When
 * several values still fit, the shortest wins: a marker almost always stands
 * for a single glyph (often a two-character ligature), so the candidate hiding
 * the fewest characters is the likeliest reading.
 *
 * Products can carry more than one option group — a bundle may have both a
 * milk type and a cup colour — so each group is resolved independently and the
 * results are recombined.
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
 * of markers matches one or more unknown characters. Returns null when the text
 * is undamaged and can simply be compared.
 */
function toPattern(damaged: string): RegExp | null {
  const squashed = squash(damaged).replace(/�+/g, MARKER);
  if (!squashed.includes(MARKER)) return null;
  const body = squashed.split(MARKER).map(escapeRegExp).join(".+?");
  return new RegExp(`^${body}$`);
}

/** True when `damaged` could be a reading of `candidate`. */
function fits(damaged: string, candidate: string): boolean {
  const target = squash(candidate);
  const pattern = toPattern(damaged);
  if (pattern) return pattern.test(target);
  return squash(damaged) === target;
}

export interface ResolvedOption {
  /** Display text, e.g. "نوع الحليب: مشروب اوتلي · لون الكوب: أبيض". */
  text: string;
  /** True when every part was confirmed against the catalog. */
  repaired: boolean;
}

/** Groups a product's variants by their option slot, preserving order. */
function groupsOf(product: Product): { name: string; values: Variant[] }[] {
  const byIndex = new Map<number, Variant[]>();
  for (const v of product.variants) {
    const key = v.groupIndex ?? 1;
    byIndex.set(key, [...(byIndex.get(key) ?? []), v]);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, values]) => ({ name: values[0].groupName, values }));
}

/** Best value from one group for one damaged fragment, or null. */
function bestInGroup(
  fragment: string,
  group: { name: string; values: Variant[] },
): Variant | null {
  const hits = group.values
    // The fragment may or may not repeat the group name, so allow both forms.
    .filter((v) => fits(fragment, `${group.name} ${v.value}`) || fits(fragment, v.value))
    // Fewest characters hidden behind a marker is the likeliest reading.
    .sort((a, b) => a.value.length - b.value.length);
  return hits[0] ?? null;
}

function clean(s: string): string {
  return s.replace(/�/g, "").replace(/\s{2,}/g, " ").trim();
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

  const groups = product ? groupsOf(product) : [];
  if (groups.length === 0) {
    const t = clean(rawOptionText);
    return t ? { text: t, repaired: false } : undefined;
  }

  // Salla prints one line per option; the parser joins them with " · ".
  const fragments = rawOptionText
    .split(/\s*·\s*|\n/)
    .map((f) => f.trim())
    .filter(Boolean);

  const parts: string[] = [];
  const usedGroups = new Set<number>();
  let allRepaired = true;

  for (const fragment of fragments) {
    let matched = false;
    for (let gi = 0; gi < groups.length; gi++) {
      if (usedGroups.has(gi)) continue;
      const hit = bestInGroup(fragment, groups[gi]);
      if (hit) {
        parts.push(`${groups[gi].name}: ${hit.value}`);
        usedGroups.add(gi);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Show what the PDF gave rather than inventing a value, and let the
      // caller flag the whole line as unverified.
      const t = clean(fragment);
      if (t) parts.push(t);
      allRepaired = false;
    }
  }

  // Fallback: some layouts put every option on a single line, so no individual
  // fragment matches. Try one value from each group against the whole string.
  if (parts.length > 0 && !allRepaired && fragments.length === 1 && groups.length > 1) {
    const combo = resolveCombined(fragments[0], groups);
    if (combo) return { text: combo, repaired: true };
  }

  const text = parts.join(" · ");
  return text ? { text, repaired: allRepaired } : undefined;
}

/**
 * Tries every combination of one value per group against a single damaged
 * string. Bounded work: option groups have a handful of values each.
 */
function resolveCombined(
  fragment: string,
  groups: { name: string; values: Variant[] }[],
): string | null {
  let best: { text: string; len: number } | null = null;

  const walk = (gi: number, chosen: Variant[]) => {
    if (gi === groups.length) {
      const joined = chosen.map((v, i) => `${groups[i].name} ${v.value}`).join(" ");
      if (!fits(fragment, joined)) return;
      const len = chosen.reduce((s, v) => s + v.value.length, 0);
      const text = chosen.map((v, i) => `${groups[i].name}: ${v.value}`).join(" · ");
      if (!best || len < best.len) best = { text, len };
      return;
    }
    for (const v of groups[gi].values) walk(gi + 1, [...chosen, v]);
  };

  walk(0, []);
  return best ? (best as { text: string }).text : null;
}
