/**
 * Positional text reconstruction for PDF pages.
 *
 * Salla and the carriers emit Arabic one *glyph at a time*, each with its own
 * coordinates, and in no useful stream order. Reconstructing from geometry is
 * far more reliable than un-reversing the flat text dump: the x-axis tells us
 * the true reading order, so no orthographic guessing is required.
 *
 * Per line:
 *   - Arabic-dominant  → read right-to-left (sort x descending)
 *   - Latin-dominant   → read left-to-right (sort x ascending)
 *
 * Latin words, order numbers and tracking numbers arrive as single intact
 * items, so they survive either direction untouched.
 */

/** Minimal shape we need from a pdf.js TextItem. */
export interface RawItem {
  str: string;
  /** Text transform matrix; [4] is x, [5] is y (PDF user space). */
  transform: number[];
  width?: number;
  height?: number;
}

export interface PositionedLine {
  y: number;
  text: string;
  /** True when the line was read right-to-left. */
  rtl: boolean;
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-z]/;

/** Lines closer together than this (in points) are treated as the same row. */
const LINE_TOLERANCE = 3;

/**
 * Gap (relative to glyph width) that implies a word break. Arabic glyphs are
 * emitted adjacent with near-zero gaps, so this stays deliberately small.
 */
const SPACE_RATIO = 0.28;

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

function scriptOf(s: string): "ar" | "la" | "neutral" {
  if (ARABIC.test(s)) return "ar";
  if (LATIN.test(s)) return "la";
  return "neutral";
}

/**
 * Groups raw pdf.js items into visual lines and resolves each line's reading
 * direction, returning logical-order text.
 */
export function reconstructLines(items: RawItem[]): PositionedLine[] {
  const usable = items.filter((it) => it.str && it.str.trim() !== "");
  if (usable.length === 0) return [];

  // Bucket by y. PDF y grows upward, so descending y is top-to-bottom.
  const rows: { y: number; items: RawItem[] }[] = [];
  for (const it of usable) {
    const y = it.transform[5];
    const row = rows.find((r) => Math.abs(r.y - y) <= LINE_TOLERANCE);
    if (row) row.items.push(it);
    else rows.push({ y, items: [it] });
  }
  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    // Decide direction by weighing how much of the row is Arabic vs Latin.
    // Count real letters only. Digits are script-neutral: a long tracking
    // number like DNL05685129123 must not outvote the Arabic label beside it.
    let ar = 0;
    let la = 0;
    for (const it of row.items) {
      ar += countMatches(it.str, new RegExp(ARABIC.source, "g"));
      la += countMatches(it.str, /[A-Za-z]/g);
    }
    const rtl = ar > la;

    const ordered = [...row.items].sort((a, b) =>
      rtl ? b.transform[4] - a.transform[4] : a.transform[4] - b.transform[4],
    );

    let text = "";
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      if (i > 0) {
        const prev = ordered[i - 1];
        // Measure the horizontal gap between this glyph and the previous one,
        // in whichever direction we are reading.
        const prevX = prev.transform[4];
        const curX = it.transform[4];
        const prevW = prev.width ?? 0;
        const curW = it.width ?? 0;
        const gap = rtl ? prevX - (curX + curW) : curX - (prevX + prevW);
        const scale = Math.max(prevW, curW, 1);
        // Salla sets numbers flush against Arabic ("فاخرة50جرام", "164.99SAR").
        // A script change is a word boundary even when the glyphs touch.
        // Break on an Arabic/non-Arabic boundary only. Deliberately *not* on
        // Latin/digit boundaries, which would split "DNL05685129123" apart.
        const scriptBreak =
          (scriptOf(prev.str) === "ar") !== (scriptOf(it.str) === "ar");
        if (gap > scale * SPACE_RATIO || scriptBreak) text += " ";
      }
      text += it.str;
    }

    return {
      y: row.y,
      // NFKC folds presentation forms back to base letters and expands
      // ligatures. Order is already correct, so no reversal is involved.
      text: text.normalize("NFKC").replace(/\s{2,}/g, " ").trim(),
      rtl,
    };
  });
}

/** Convenience: reconstructed page as newline-joined logical text. */
export function reconstructText(items: RawItem[]): string {
  return reconstructLines(items)
    .map((l) => l.text)
    .filter(Boolean)
    .join("\n");
}
