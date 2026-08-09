/**
 * Shipping-label PDF parser.
 *
 * Labels are parsed independently of orders and joined later through a match
 * link, so a bad match can be corrected without re-reading either file.
 */

import { toAsciiDigits } from "../arabic.ts";
import { detectCarrier, type CarrierTemplate } from "../carriers.ts";
import { reconstructText, type RawItem } from "./layout.ts";

export interface ParsedLabel {
  carrierId?: string;
  carrierName?: string;
  /** Tracking number exactly as printed. */
  trackingRaw?: string;
  /** SMSA prints a MASTER# that differs from the piece barcode. */
  masterNumber?: string;
  /** Order number printed on the label, when the carrier includes it. */
  orderNumberOnLabel?: string;
  recipientName?: string;
  city?: string;
  codAmount?: number;
  weight?: string;
  pieces?: number;
  sourcePage: number;
  warnings: string[];
}

/**
 * A 9-digit order number. Carriers print it flush against the city
 * ("Dammam274080065"), so word boundaries are useless here; what matters is
 * that the run is not part of a *longer* number such as a phone or account id.
 */
const RE_ORDER_NO = /(?<!\d)(\d{9})(?!\d)/;
const RE_COD = /COD\s*[:：]?\s*([\d.,]+)/i;
const RE_DV = /DV\s*[:：]\s*[A-Z]{3}\s*([\d.,]+)/i;
const RE_WEIGHT = /(?:WGT|Weight)\s*[:：]?\s*([\d.]+\s*[A-Za-z]*)/i;
const RE_PIECES = /(?:PCs|Pieces)\s*[:：]?\s*(\d+)/i;
const RE_CITY_EN = /City\s*[:：]\s*([A-Za-z \-]+)/i;

/** Arabic line that looks like a person's name (no digits, 2+ words). */
const RE_ARABIC_NAME = /^[؀-ۿ\s]{6,}$/;

/**
 * Lines whose 9-digit runs are contact/account data, never an order number.
 * Saudi mobile numbers are also 9 digits once the country code is stripped.
 */
const RE_CONTACT_FIELD =
  /Mobile|Tel\b|Phone|Toll\s*free|Account\s*number|National\s*ID|Ship\s*Date|VAT|C\.?R\.?\b/i;

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(toAsciiDigits(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function extractTracking(
  text: string,
  carrier: CarrierTemplate | undefined,
): string | undefined {
  if (!carrier) return undefined;
  for (const re of carrier.trackingPatterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function parseOneLabel(pageText: string, page: number): ParsedLabel {
  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);
  const text = lines.join("\n");
  const warnings: string[] = [];

  const carrier = detectCarrier(text);
  if (!carrier) warnings.push("لم نتعرّف على شركة الشحن من البوليصة");

  const trackingRaw = extractTracking(text, carrier);
  if (!trackingRaw) warnings.push("تعذّرت قراءة رقم الشحنة من البوليصة");

  const masterNumber = text
    .match(/MASTER\s*#\s*[:：]?\s*(\d{4}(?:\s?\d{4}){2})/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();

  // The order number is a bare 9-digit run. So is a Saudi mobile number, and
  // SMSA prints the sender's mobile above the order number — taking the first
  // match would mis-identify the label. Lines carrying a contact or account
  // field are therefore excluded before choosing.
  let orderNumberOnLabel: string | undefined;
  for (const line of lines) {
    if (RE_CONTACT_FIELD.test(line)) continue;
    const m = line.match(RE_ORDER_NO);
    if (!m) continue;
    const candidate = m[1];
    const inTracking =
      trackingRaw && trackingRaw.replace(/\s+/g, "").includes(candidate);
    if (!inTracking) {
      orderNumberOnLabel = candidate;
      break;
    }
  }
  if (!orderNumberOnLabel) warnings.push("لا يوجد رقم طلب مطبوع على البوليصة");

  // Recipient: the first pure-Arabic line after a "Ship to"/"To" marker,
  // falling back to the longest Arabic line that is not the sender.
  let recipientName: string | undefined;
  const toIdx = lines.findIndex((l) => /Ship\s*to|^To\s*[:：]/i.test(l));
  if (toIdx >= 0) {
    recipientName = lines
      .slice(toIdx, toIdx + 4)
      .find((l) => RE_ARABIC_NAME.test(l) && !/متجر/.test(l));
  }
  if (!recipientName) {
    recipientName = lines.find((l) => RE_ARABIC_NAME.test(l) && !/متجر/.test(l));
  }

  const city = text.match(RE_CITY_EN)?.[1]?.trim();
  const codAmount = num(text.match(RE_COD)?.[1]) ?? num(text.match(RE_DV)?.[1]);
  const weight = text.match(RE_WEIGHT)?.[1]?.trim();
  const pieces = num(text.match(RE_PIECES)?.[1]);

  return {
    carrierId: carrier?.id,
    carrierName: carrier?.name,
    trackingRaw,
    masterNumber,
    orderNumberOnLabel,
    recipientName,
    city,
    codAmount,
    weight,
    pieces: pieces === undefined ? undefined : Math.trunc(pieces),
    sourcePage: page,
    warnings,
  };
}

/** One label per page — the format every carrier in the registry uses. */
export function parseLabelPages(pageTexts: string[]): ParsedLabel[] {
  return pageTexts.map((t, i) => parseOneLabel(t, i + 1));
}

export function parseLabelsFromItems(pages: RawItem[][]): ParsedLabel[] {
  return parseLabelPages(pages.map(reconstructText));
}
