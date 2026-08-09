/**
 * Salla invoice/order PDF parser.
 *
 * One order per page in every sample seen so far, but the parser keys off the
 * order-number marker rather than page boundaries so a multi-order page or a
 * continuation page degrades gracefully instead of dropping data.
 */

import { toAsciiDigits } from "../arabic.ts";
import { detectCarrier, detectPaymentMethod } from "../carriers.ts";
import { reconstructText, type RawItem } from "./layout.ts";

export interface ParsedOrderItem {
  name: string;
  /** Salla's internal product id, printed in the رقم المنتج column. */
  sallaProductId?: string;
  category?: string;
  sku?: string;
  quantity: number;
  /** Chosen variant, e.g. "نوع الحليب مشروب اوتلي". */
  optionText?: string;
}

export interface ParsedOrder {
  orderNumber: string;
  customerName?: string;
  phone?: string;
  city?: string;
  country?: string;
  address?: string;
  carrierId?: string;
  carrierName?: string;
  trackingRaw?: string;
  paymentMethod?: string;
  /** "cod" when the invoice is stamped COD, else "prepaid". */
  paymentType: "cod" | "prepaid";
  totalAmount?: number;
  currency?: string;
  placedAt?: string;
  items: ParsedOrderItem[];
  sourcePage: number;
  /** Lines we could not attribute, kept for the issues screen. */
  warnings: string[];
}

const RE_ORDER_NO = /#?(\d{9})\b/;
const RE_PHONE = /\+?9\d{10,13}/;
const RE_TRACKING_LABEL = /رقم\s*الشحنة\s*[:：]?\s*([A-Z0-9][A-Z0-9\s-]{6,})/i;
const RE_AMOUNT = /المبلغ\s*([\d.,]+)\s*([A-Z]{3})?/;
const RE_PAYMENT = /طريقة\s*الدفع\s*(.+?)(?:\s{2,}|رقم\s*الشحنة|$)/;
const RE_CARRIER = /بواسطة\s*(.+?)(?:\)\)|\(\(|الشحن|$)/;
const RE_DATE = /([A-Z][a-z]+day\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{4}[^\n]*)/;

/**
 * Product table row, e.g.
 *   "شاي ماتشا 150g 88224991 جميع المنتجات 6971291060131 1"
 *    ^name          ^salla id ^category     ^sku          ^qty
 *
 * Widths are deliberately loose: Salla product IDs run 8–9 digits and the
 * stock code is anything from a 4-digit internal code ("0007") to a 13-digit
 * GTIN, and may be alphanumeric. Pinning these to exact lengths silently
 * dropped whole orders' worth of line items.
 */
const RE_PRODUCT_ROW =
  /^(.+?)\s+(\d{6,12})\s+(.+?)\s+(\S+)\s+(\d{1,4})$/;

/** Header Salla prints above a line item's chosen variant options. */
const RE_OPTIONS_HEADER = /خيارات\s*المنتج/;

/** Countries appear on their own line directly above the city. */
const COUNTRIES = ["السعودية", "الإمارات", "الكويت", "البحرين", "عمان", "قطر"];

function cleanLine(s: string): string {
  // pdf.js emits U+FFFD for glyphs the embedded font maps oddly. They are
  // cosmetic; strip them so they never leak into a customer name on screen.
  return s.replace(/�/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Cleaner for variant text, which deliberately KEEPS the U+FFFD markers.
 *
 * Each one stands for a glyph the font could not map back to characters, and
 * knowing *where* the gaps are is what lets the catalog resolve the real value
 * later ("نوع الحليب م�وب اوت�" → "مشروب اوتلي"). Stripping them first would
 * throw away the only positional evidence there is.
 */
function cleanOptionLine(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}

/** Splits a page's reconstructed lines into one chunk per order number. */
function splitIntoOrders(lines: string[]): { start: number; end: number }[] {
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/رقم\s*الطلب/.test(l)) starts.push(i);
  });
  if (starts.length === 0) return [{ start: 0, end: lines.length }];
  return starts.map((s, i) => ({
    start: s,
    end: i + 1 < starts.length ? starts[i + 1] : lines.length,
  }));
}

function parseOneOrder(lines: string[], page: number): ParsedOrder | null {
  const text = lines.join("\n");
  const warnings: string[] = [];

  // Order number: prefer the line right after the رقم الطلب label.
  let orderNumber = "";
  const labelIdx = lines.findIndex((l) => /رقم\s*الطلب/.test(l));
  for (let i = labelIdx; i >= 0 && i < Math.min(labelIdx + 3, lines.length); i++) {
    const m = lines[i].match(RE_ORDER_NO);
    if (m) {
      orderNumber = m[1];
      break;
    }
  }
  if (!orderNumber) {
    const m = text.match(RE_ORDER_NO);
    if (m) orderNumber = m[1];
  }
  if (!orderNumber) return null;

  // The COD stamp at the top of the invoice and the printed payment method are
  // two independent signals; either one is enough to treat the order as COD,
  // because getting this wrong means a packer collects the wrong amount.
  const payment = detectPaymentMethod(text);
  const paymentType: ParsedOrder["paymentType"] =
    /\bCOD\b/.test(text) || payment?.cod ? "cod" : "prepaid";

  const phone = text.match(RE_PHONE)?.[0];

  // Address block: country line, city on the following line, then the street.
  let country: string | undefined;
  let city: string | undefined;
  let address: string | undefined;
  let customerName: string | undefined;
  const countryIdx = lines.findIndex((l) =>
    COUNTRIES.some((c) => cleanLine(l) === c),
  );
  if (countryIdx >= 0) {
    country = cleanLine(lines[countryIdx]);
    if (countryIdx + 1 < lines.length) city = cleanLine(lines[countryIdx + 1]);
    if (countryIdx + 2 < lines.length) address = cleanLine(lines[countryIdx + 2]);
    // The customer name sits directly above the country.
    if (countryIdx - 1 >= 0) customerName = cleanLine(lines[countryIdx - 1]);
  } else {
    warnings.push("تعذّر تحديد عنوان العميل");
  }

  const amountM = text.match(RE_AMOUNT);
  const totalAmount = amountM ? Number(toAsciiDigits(amountM[1]).replace(/,/g, "")) : undefined;
  const currency = amountM?.[2] ?? (/(SAR)/.test(text) ? "SAR" : undefined);

  const trackingRaw = text.match(RE_TRACKING_LABEL)?.[1]?.trim();
  if (!trackingRaw) warnings.push("لا يوجد رقم شحنة على الفاتورة");

  // Prefer the registry over free-text capture: the "بواسطة" phrase is split
  // across columns on COD invoices, so the literal capture comes back empty.
  const carrier = detectCarrier(text);
  const carrierName = carrier?.name ?? text.match(RE_CARRIER)?.[1]?.trim() ?? undefined;
  const paymentMethod = payment?.label;
  const placedAt = text.match(RE_DATE)?.[1]?.trim();

  // Product rows live between the table header and the closing thank-you line.
  const items: ParsedOrderItem[] = [];
  const headerIdx = lines.findIndex(
    (l) => /المنتج/.test(l) && /الكمية/.test(l),
  );
  const footerIdx = lines.findIndex((l) => /شكرًا|شكراً/.test(l));
  if (headerIdx >= 0) {
    const end = footerIdx > headerIdx ? footerIdx : lines.length;
    let pending: ParsedOrderItem | null = null;
    // Lines after the "خيارات المنتج" header describe the chosen variant, not
    // a continuation of the product name.
    let inOptions = false;
    for (let i = headerIdx + 1; i < end; i++) {
      const line = cleanLine(lines[i]);
      if (!line) continue;

      const m = line.match(RE_PRODUCT_ROW);
      if (m) {
        pending = {
          name: cleanLine(m[1]),
          sallaProductId: m[2],
          category: cleanLine(m[3]),
          sku: m[4],
          quantity: Number(toAsciiDigits(m[5])) || 1,
        };
        items.push(pending);
        inOptions = false;
        continue;
      }

      if (RE_OPTIONS_HEADER.test(line)) {
        inOptions = true;
        continue;
      }

      if (!pending) continue;

      if (inOptions) {
        const raw = cleanOptionLine(lines[i]);
        pending.optionText = pending.optionText
          ? `${pending.optionText} · ${raw}`
          : raw;
      } else {
        // Long product names wrap onto the next line ("وادواتها اسود").
        pending.name = cleanLine(`${pending.name} ${line}`);
      }
    }
  }
  if (items.length === 0) warnings.push("تعذّرت قراءة أصناف الطلب");

  return {
    orderNumber,
    customerName,
    phone,
    city,
    country,
    address,
    carrierId: carrier?.id,
    carrierName,
    trackingRaw,
    paymentMethod,
    paymentType,
    totalAmount,
    currency,
    placedAt,
    items,
    sourcePage: page,
    warnings,
  };
}

/** Parses reconstructed page texts into orders. */
export function parseOrderPages(pageTexts: string[]): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  pageTexts.forEach((pageText, pi) => {
    // Lines are kept raw here — including the U+FFFD markers — because the
    // variant handler needs to know where the unmapped glyphs were. Individual
    // fields are cleaned as they are extracted.
    const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const { start, end } of splitIntoOrders(lines)) {
      const order = parseOneOrder(lines.slice(start, end), pi + 1);
      if (order) out.push(order);
    }
  });
  return out;
}

/** Parses raw pdf.js items (one array per page) into orders. */
export function parseOrdersFromItems(pages: RawItem[][]): ParsedOrder[] {
  return parseOrderPages(pages.map(reconstructText));
}
