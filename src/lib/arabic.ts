/**
 * Arabic text recovery for PDF extraction.
 *
 * Salla's invoice PDFs embed Arabic as *presentation forms* (U+FB50–U+FDFF,
 * U+FE70–U+FEFF) laid out in *visual* order. A naive text extraction therefore
 * yields strings that are both mis-encoded and backwards:
 *
 *   raw:      "ﻢﻗر  ﺐﻠﻄﻟا"
 *   recovered: "رقم الطلب"
 *
 * Recovery is two steps, and the order matters:
 *
 *   1. Reverse the characters of each Arabic run (visual → logical).
 *   2. NFKC-normalise, which maps every presentation form back to its base
 *      letter and expands ligatures.
 *
 * Doing NFKC *first* would be a bug: the lam-alef ligature (U+FEFB) expands to
 * two characters (لا). Reversing after expansion would flip them into "ال".
 * Reversing first keeps the ligature atomic, so its expansion lands correctly.
 *
 * Empirically, each whitespace-separated token is an independent visual run and
 * token order is already logical — so reversal is applied per token, not per
 * line. Latin/digit tokens are left untouched.
 */

/** Arabic presentation forms: Arabic Presentation Forms-A and -B. */
const PRESENTATION_FORM = /[ﭐ-﷿ﹰ-﻿]/;

/** Any Arabic character, including the base block. */
const ARABIC_CHAR = /[؀-ۿﭐ-﷿ﹰ-﻿]/;

/** Characters that mirror when a run is reversed (brackets, parens, slashes). */
const MIRRORED: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
};

/** Arabic-Indic digits U+0660–U+0669, and the Eastern set U+06F0–U+06F9. */
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/**
 * Latin letters, digits and the punctuation that binds them (e.g. "164.99",
 * "DNL05685129123", "sku-01"). These are LTR runs *inside* RTL text: reversing
 * the surrounding Arabic must not reverse them too.
 */
const LTR_RUN = /[A-Za-z0-9][A-Za-z0-9._\-+/@]*/g;

/**
 * Recovers one visual-order Arabic run into logical order.
 * Safe to call on non-Arabic input, which is returned unchanged.
 */
export function recoverArabicRun(run: string): string {
  // Pure Latin/numeric tokens are already logical — never flip them.
  if (!PRESENTATION_FORM.test(run) && !ARABIC_CHAR.test(run)) return run;

  const reversed = Array.from(run)
    .reverse()
    .map((ch) => MIRRORED[ch] ?? ch)
    .join("")
    .normalize("NFKC");

  // Salla glues the product ID straight onto the Arabic name ("115282434جميع"),
  // so the digits ride along through the reversal and come out backwards.
  // Flip every embedded Latin/digit run back to its logical direction.
  return reversed.replace(LTR_RUN, (m) => Array.from(m).reverse().join(""));
}

/** Applies a per-token transform while preserving line and space structure. */
function perToken(raw: string, fn: (tok: string) => string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        // Keep the whitespace runs so column alignment survives.
        .split(/(\s+)/)
        .map((tok) => (/^\s*$/.test(tok) ? tok : fn(tok)))
        .join("")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .join("\n");
}

/** De-shapes presentation forms without touching order. */
function deshapeToken(tok: string): string {
  return tok.normalize("NFKC");
}

/**
 * Decides whether base-letter Arabic text is laid out in visual (reversed)
 * order, by scoring orthographic positions that are fixed in real Arabic.
 *
 * The strongest signal is taa marbuta (ة), which is *always* word-final; seeing
 * it word-initial means the run is reversed. The definite article "ال" is the
 * mirror signal: word-initial when logical, trailing "لا" when reversed.
 *
 * Scoring across the whole page rather than per token keeps a few ambiguous
 * words (لا, هذا) from flipping the verdict.
 */
export function looksVisualOrder(raw: string): boolean {
  let visual = 0;
  let logical = 0;

  for (const tok of raw.split(/\s+/)) {
    if (tok.length < 3 || !ARABIC_CHAR.test(tok)) continue;

    if (tok.startsWith("ة")) visual += 2;
    if (tok.endsWith("ة")) logical += 2;
    // Hamza-on-the-line rarely opens a word; it commonly closes one (العلاء).
    if (tok.startsWith("ء")) visual += 1;
    if (tok.endsWith("ء")) logical += 1;
    if (tok.endsWith("لا")) visual += 1;
    if (tok.startsWith("ال")) logical += 1;
    // Alef maqsura (ى) is word-final only.
    if (tok.startsWith("ى")) visual += 2;
    if (tok.endsWith("ى")) logical += 2;
  }

  return visual > logical;
}

/**
 * Recovers a full block of PDF-extracted text into logical reading order.
 *
 * Both Salla invoices and the carrier labels embed Arabic as presentation
 * forms, but they differ in *ordering*, which is what actually has to be
 * detected:
 *
 *   - Salla invoices lay the glyphs out in visual order  → reverse, then NFKC.
 *   - SMSA / Deliver Now labels are already logical      → NFKC only.
 *
 * Reversing an already-logical label would silently corrupt every name on it,
 * so ordering is probed on a cheap de-shaped copy before committing to a
 * transform. The reverse-then-NFKC path is kept intact for the visual case
 * because it is the only order that expands the lam-alef ligature correctly.
 *
 * Latin words, order numbers and tracking numbers pass through untouched in
 * both cases. Line structure is preserved because callers locate fields by it.
 */
export function recoverArabicText(raw: string): string {
  if (!ARABIC_CHAR.test(raw) && !PRESENTATION_FORM.test(raw)) {
    return perToken(raw, (t) => t);
  }

  // Probe: de-shape without reordering, so the scorer sees real letters.
  if (looksVisualOrder(raw.normalize("NFKC"))) {
    return perToken(raw, recoverArabicRun);
  }
  return perToken(raw, deshapeToken);
}

/** True if the string contains any Arabic character at all. */
export function hasArabic(s: string): boolean {
  return ARABIC_CHAR.test(s);
}

/**
 * Normalises Arabic for *comparison*: strips diacritics and tatweel, and folds
 * the orthographic variants merchants type inconsistently (أ/إ/آ→ا, ة→ه, ى→ي).
 * Used for fuzzy-matching product names between the PDF and the catalog.
 */
export function foldArabic(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[ً-ٰٟ]/g, "") // harakat
    .replace(/ـ/g, "") // tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Converts ASCII digits to Arabic-Indic, for display only. */
export function toArabicDigits(v: string | number): string {
  return String(v).replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]);
}

/** Converts Arabic-Indic / Eastern-Indic digits to ASCII, for parsing. */
export function toAsciiDigits(v: string): string {
  return v.replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : EASTERN_INDIC.indexOf(d));
  });
}
