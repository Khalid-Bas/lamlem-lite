/**
 * Barcode normalisation, alias generation and scan resolution.
 *
 * This is the one piece of logic where a bug puts the wrong label on a box, so
 * it is kept pure, dependency-free and covered disproportionately by tests.
 *
 * Normalisation rules (applied before storing an alias and before every scan):
 *   1. Arabic-Indic digits → ASCII
 *   2. strip all whitespace and separators
 *   3. uppercase
 *   4. strip carrier-specific affixes (e.g. Deliver Now's DNL prefix)
 */

import { toAsciiDigits } from "./arabic.ts";
import { carrierById, CARRIERS } from "./carriers.ts";

export type AliasType =
  | "order_number"
  | "tracking"
  | "master"
  | "carrier_specific";

export interface BarcodeAlias {
  /** Which order this alias resolves to. */
  orderId: string;
  value: string;
  type: AliasType;
}

export type ScanResult =
  /** Exactly one order matched, and it is the box in front of the packer. */
  | { kind: "green"; orderId: string; alias: BarcodeAlias }
  /** Exactly one order matched, but it is a *different* box. */
  | { kind: "red"; orderId: string; expectedOrderId: string; alias: BarcodeAlias }
  /** Nothing in this batch matched. */
  | { kind: "yellow"; scanned: string }
  /** More than one order plausibly matched — needs a human pick. */
  | { kind: "orange"; scanned: string; candidates: string[] };

/** Characters carriers sprinkle through printed barcodes that carry no meaning. */
const SEPARATORS = /[\s\-_.·/\\]+/g;

/** Base normalisation, independent of carrier. */
export function normalizeBarcode(raw: string): string {
  return toAsciiDigits(String(raw ?? ""))
    .replace(SEPARATORS, "")
    .toUpperCase()
    .trim();
}

/**
 * Carrier-aware normalisation: also strips the carrier's known affixes.
 * When the carrier is unknown, every registered carrier's affixes are tried,
 * because a merchant may scan a label we could not classify.
 */
export function normalizeForCarrier(raw: string, carrierId?: string): string {
  let v = normalizeBarcode(raw);
  const templates = carrierId
    ? [carrierById(carrierId)].filter(Boolean)
    : CARRIERS;
  for (const t of templates) {
    for (const affix of t!.stripAffixes ?? []) {
      v = v.replace(affix, "");
    }
  }
  return v;
}

/**
 * Every value that should resolve to a given order.
 *
 * Both the raw and affix-stripped forms of a tracking number are registered, so
 * scanning either "DNL05685129123" or "05685129123" finds the same box.
 */
export function buildAliases(order: {
  id: string;
  orderNumber: string;
  carrierId?: string;
  trackingRaw?: string;
  masterNumber?: string;
  extraAliases?: string[];
}): BarcodeAlias[] {
  const out: BarcodeAlias[] = [];
  const push = (value: string | undefined, type: AliasType) => {
    if (!value) return;
    for (const form of [
      normalizeBarcode(value),
      normalizeForCarrier(value, order.carrierId),
    ]) {
      if (form && !out.some((a) => a.value === form && a.type === type)) {
        out.push({ orderId: order.id, value: form, type });
      }
    }
  };

  push(order.orderNumber, "order_number");
  push(order.trackingRaw, "tracking");
  push(order.masterNumber, "master");
  for (const extra of order.extraAliases ?? []) push(extra, "carrier_specific");

  return out;
}

/**
 * Shortest alias length that may be resolved by prefix rather than exact match.
 * Below this, a partial scan is too likely to collide with an unrelated order.
 */
const MIN_PREFIX_LEN = 8;

/**
 * Resolves a scanned value against the batch's aliases.
 *
 * `expectedOrderId` is the box physically in front of the packer; it decides
 * green vs red. Resolution is exact-match first, then a guarded prefix match
 * for scanners configured to truncate.
 */
export function resolveScan(
  rawScan: string,
  aliases: BarcodeAlias[],
  expectedOrderId?: string,
): ScanResult {
  const scanned = String(rawScan ?? "").trim();
  const v = normalizeForCarrier(scanned);
  if (!v) return { kind: "yellow", scanned };

  const exact = aliases.filter((a) => a.value === v);
  const distinct = [...new Set(exact.map((a) => a.orderId))];

  if (distinct.length === 1) return verdict(distinct[0], exact[0], expectedOrderId);
  if (distinct.length > 1) {
    return { kind: "orange", scanned, candidates: distinct };
  }

  if (v.length >= MIN_PREFIX_LEN) {
    const partial = aliases.filter((a) => a.value.startsWith(v));
    const partialIds = [...new Set(partial.map((a) => a.orderId))];
    if (partialIds.length === 1) {
      return verdict(partialIds[0], partial[0], expectedOrderId);
    }
    if (partialIds.length > 1) {
      return { kind: "orange", scanned, candidates: partialIds };
    }
  }

  return { kind: "yellow", scanned };
}

function verdict(
  orderId: string,
  alias: BarcodeAlias,
  expectedOrderId?: string,
): ScanResult {
  // With no box selected there is nothing to contradict, so a hit is a hit.
  if (!expectedOrderId || orderId === expectedOrderId) {
    return { kind: "green", orderId, alias };
  }
  return { kind: "red", orderId, expectedOrderId, alias };
}

/**
 * Auto-matches parsed labels to parsed orders.
 * Returns a link per order plus any labels that found no home.
 */
export interface MatchLink {
  orderId: string;
  labelIndex?: number;
  status: "matched" | "unmatched_order" | "ambiguous";
  method: "order_number" | "tracking" | "none";
}

export function autoMatch(
  orders: { id: string; orderNumber: string; trackingRaw?: string }[],
  labels: { orderNumberOnLabel?: string; trackingRaw?: string }[],
): { links: MatchLink[]; orphanLabels: number[] } {
  const used = new Set<number>();
  const links: MatchLink[] = [];

  for (const order of orders) {
    const orderNo = normalizeBarcode(order.orderNumber);
    const orderTrack = order.trackingRaw
      ? normalizeForCarrier(order.trackingRaw)
      : undefined;

    const candidates: { i: number; method: MatchLink["method"] }[] = [];
    labels.forEach((label, i) => {
      if (used.has(i)) return;
      if (
        label.orderNumberOnLabel &&
        normalizeBarcode(label.orderNumberOnLabel) === orderNo
      ) {
        candidates.push({ i, method: "order_number" });
        return;
      }
      if (
        orderTrack &&
        label.trackingRaw &&
        normalizeForCarrier(label.trackingRaw) === orderTrack
      ) {
        candidates.push({ i, method: "tracking" });
      }
    });

    if (candidates.length === 1) {
      used.add(candidates[0].i);
      links.push({
        orderId: order.id,
        labelIndex: candidates[0].i,
        status: "matched",
        method: candidates[0].method,
      });
    } else if (candidates.length > 1) {
      links.push({ orderId: order.id, status: "ambiguous", method: "none" });
    } else {
      links.push({ orderId: order.id, status: "unmatched_order", method: "none" });
    }
  }

  const orphanLabels = labels
    .map((_, i) => i)
    .filter((i) => !used.has(i));

  return { links, orphanLabels };
}
