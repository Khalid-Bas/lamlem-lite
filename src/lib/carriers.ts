/**
 * Carrier template registry.
 *
 * Per the design spec, a new carrier should be onboardable by adding a config
 * entry — not by changing parser code. Each template describes how to recognise
 * the carrier in either document, how to pull a tracking number off its label,
 * and how to normalise that tracking number for barcode lookup.
 */

export interface CarrierTemplate {
  id: string;
  /** Display name, Arabic first since the whole UI is Arabic. */
  name: string;
  nameEn: string;
  /** Any of these appearing in the document identifies the carrier. */
  signals: RegExp[];
  /** Ordered patterns tried against label text to extract the tracking number. */
  trackingPatterns: RegExp[];
  /**
   * Carrier-specific prefixes/suffixes stripped during normalisation, so a
   * scan of "DNL05685129123" also matches a bare "05685129123".
   */
  stripAffixes?: RegExp[];
}

export const CARRIERS: CarrierTemplate[] = [
  {
    id: "smsa",
    name: "سمسا",
    nameEn: "SMSA",
    signals: [/سمسا/, /\bSMSA\b/i, /MASTER\s*#/i, /\bSAAKJ\b/i],
    trackingPatterns: [
      // "MASTER#: 2916 7592 6569 1 of 1" — the piece counter that follows must
      // not be absorbed, so the digit groups are matched exactly, not greedily.
      /MASTER\s*#\s*[:：]?\s*(\d{4}(?:\s?\d{4}){2})/i,
      /\b(\d{4}\s\d{4}\s\d{4})\b/,
      /\b(\d{12})\b/,
    ],
  },
  {
    id: "deliver_now",
    name: "دليفر ناو",
    nameEn: "Deliver Now",
    signals: [/دليفر\s*ناو/, /Deliver\s*Now/i, /\bDNL\d/],
    trackingPatterns: [/\b(DNL\d{6,})\b/i],
    // The DNL prefix is printed on the label but often absent from the
    // merchant-facing number, so both forms must resolve to one alias.
    stripAffixes: [/^DNL/i, /DNL$/i],
  },
  {
    id: "aramex",
    name: "أرامكس",
    nameEn: "Aramex",
    signals: [/أرامكس/, /ارامكس/, /\bAramex\b/i],
    trackingPatterns: [/\b(\d{10,11})\b/],
  },
  {
    id: "spl",
    name: "البريد السعودي",
    nameEn: "Saudi Post (SPL)",
    signals: [/البريد\s*السعودي/, /\bSPL\b/i, /سبل/],
    trackingPatterns: [/\b([A-Z]{2}\d{9}[A-Z]{2})\b/],
  },
  {
    id: "imile",
    name: "آي مايل",
    nameEn: "iMile",
    signals: [/آي\s*مايل/, /\biMile\b/i],
    trackingPatterns: [/\b(IM\w{8,})\b/i],
  },
  {
    id: "jt",
    name: "جي آند تي",
    nameEn: "J&T Express",
    signals: [/جي\s*اند\s*تي/, /J&T/i],
    trackingPatterns: [/\b(\d{12,14})\b/],
  },
];

/** Identifies the carrier a document belongs to, if any. */
export function detectCarrier(text: string): CarrierTemplate | undefined {
  return CARRIERS.find((c) => c.signals.some((re) => re.test(text)));
}

export function carrierById(id: string | undefined): CarrierTemplate | undefined {
  return id ? CARRIERS.find((c) => c.id === id) : undefined;
}

/**
 * Payment methods Salla prints on the invoice, mapped to a COD flag.
 *
 * Note: deliberately no word-boundary anchors around the Arabic literals. JS
 * defines word boundaries over ASCII word characters only, so anchoring one
 * beside an Arabic word can never match and detection would silently fail.
 */
const PAYMENT_METHODS: { pattern: RegExp; label: string; cod: boolean }[] = [
  { pattern: /الدفع\s*عند\s*الاستلام/, label: "الدفع عند الاستلام", cod: true },
  { pattern: /\bCOD\b/i, label: "الدفع عند الاستلام", cod: true },
  { pattern: /مدى/, label: "مدى", cod: false },
  { pattern: /فيزا|\bVisa\b/i, label: "فيزا", cod: false },
  { pattern: /ماستر\s*كارد|MasterCard/i, label: "ماستركارد", cod: false },
  { pattern: /آبل\s*باي|Apple\s*Pay/i, label: "آبل باي", cod: false },
  { pattern: /تمارا|Tamara/i, label: "تمارا", cod: false },
  { pattern: /تابي|Tabby/i, label: "تابي", cod: false },
  { pattern: /STC\s*Pay/i, label: "STC Pay", cod: false },
  { pattern: /تحويل\s*بنكي/, label: "تحويل بنكي", cod: false },
];

export function detectPaymentMethod(
  text: string,
): { label: string; cod: boolean } | undefined {
  const hit = PAYMENT_METHODS.find((p) => p.pattern.test(text));
  return hit ? { label: hit.label, cod: hit.cod } : undefined;
}
