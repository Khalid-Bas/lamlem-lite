"use client";

import { readPdfItems } from "./pdf/read-client.ts";
import { parseOrdersFromItems } from "./pdf/orders.ts";
import { parseLabelsFromItems } from "./pdf/labels.ts";
import { autoMatch } from "./barcode.ts";
import { readCatalog } from "./catalog-load.ts";
import { resolveOption } from "./options.ts";
import { foldArabic } from "./arabic.ts";
import type { Batch, PackItem, PackOrder } from "./types.ts";
import type { Product } from "./catalog-types.ts";

/**
 * Turns the uploads into one packable batch, entirely in the browser.
 *
 * Everything happens on the device: the PDFs hold customer names, phone
 * numbers and addresses, and none of it needs to leave the phone.
 */

export interface BuildProgress {
  stage: string;
  done: number;
  total: number;
}

/** Reported back so a bad or missing catalog is visible before packing starts. */
export interface BuildStats {
  orders: number;
  labels: number;
  matchedLabels: number;
  lineItems: number;
  /** Line items resolved to a catalog product. */
  linkedItems: number;
  /** Line items that ended up with a photo. */
  itemsWithPhoto: number;
  catalogProducts: number;
}

/**
 * Normalises an identifier for comparison.
 *
 * The same SKU can arrive as "0007" from one export and 7 from another once a
 * spreadsheet has treated it as a number, and long ids can pick up separators.
 * Comparing on digits alone, without leading zeros, survives all of that.
 */
export function sameId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const norm = (v: string) => v.replace(/[^0-9A-Za-z]/g, "").replace(/^0+/, "");
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/** Resolves an order line to a catalog product, best signal first. */
export function findProduct(
  item: { sallaProductId?: string; sku?: string; name: string },
  products: Product[],
): Product | undefined {
  if (item.sallaProductId) {
    const hit = products.find((p) => sameId(p.sallaId, item.sallaProductId));
    if (hit) return hit;
  }
  if (item.sku) {
    const hit = products.find((p) => sameId(p.sku, item.sku));
    if (hit) return hit;
  }
  const folded = foldArabic(item.name);
  const exact = products.filter((p) => foldArabic(p.name) === folded);
  if (exact.length === 1) return exact[0];

  // Last resort: compare with all spaces removed, so a lost space in the PDF
  // ("استكر شيتمن قوت") still finds its product.
  const squashed = folded.replace(/\s+/g, "");
  const loose = products.filter(
    (p) => foldArabic(p.name).replace(/\s+/g, "") === squashed,
  );
  return loose.length === 1 ? loose[0] : undefined;
}

/** Applies a catalog to already-parsed orders: names, photos, variant text. */
export function linkCatalog(
  orders: PackOrder[],
  products: Product[],
): { orders: PackOrder[]; linked: number; withPhoto: number } {
  let linked = 0;
  let withPhoto = 0;

  const next = orders.map((o) => ({
    ...o,
    items: o.items.map((it): PackItem => {
      const p = findProduct(
        { sallaProductId: it.sallaProductId, sku: it.sku, name: it.rawName ?? it.name },
        products,
      );
      if (p) linked++;
      const imageUrl = p?.imageUrls[0] ?? it.imageUrl;
      if (imageUrl) withPhoto++;
      const opt = resolveOption(it.rawOptionText, p);
      return {
        ...it,
        // The catalog spelling wins: the PDF drops spaces and mangles ligatures.
        name: p?.name ?? it.rawName ?? it.name,
        imageUrl,
        optionText: opt?.text,
        optionVerified: opt?.repaired ?? false,
      };
    }),
  }));

  return { orders: next, linked, withPhoto };
}

export async function buildBatch(
  ordersPdf: File,
  labelsPdf: File,
  catalogFile: File | null,
  onProgress?: (p: BuildProgress) => void,
): Promise<{ batch: Batch; stats: BuildStats }> {
  let products: Product[] = [];
  if (catalogFile) {
    onProgress?.({ stage: "قراءة ملف المنتجات", done: 0, total: 1 });
    products = await readCatalog(catalogFile);
  }

  onProgress?.({ stage: "قراءة ملف الطلبات", done: 0, total: 1 });
  const orderPages = await readPdfItems(ordersPdf, (d, t) =>
    onProgress?.({ stage: "قراءة ملف الطلبات", done: d, total: t }),
  );
  const parsedOrders = parseOrdersFromItems(orderPages.pages);

  onProgress?.({ stage: "قراءة ملف البوليصات", done: 0, total: 1 });
  const labelPages = await readPdfItems(labelsPdf, (d, t) =>
    onProgress?.({ stage: "قراءة ملف البوليصات", done: d, total: t }),
  );
  const parsedLabels = parseLabelsFromItems(labelPages.pages);

  const base: PackOrder[] = parsedOrders.map((o, i) => ({
    id: `o${i + 1}-${o.orderNumber}`,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    city: o.city,
    carrierName: o.carrierName,
    carrierId: o.carrierId,
    trackingRaw: o.trackingRaw,
    paymentType: o.paymentType,
    totalAmount: o.totalAmount,
    items: o.items.map((it) => ({
      name: it.name,
      rawName: it.name,
      quantity: it.quantity,
      sku: it.sku,
      sallaProductId: it.sallaProductId,
      rawOptionText: it.optionText,
      optionVerified: false,
    })),
  }));

  // The label is the authority on the tracking number — it is the barcode that
  // will actually be scanned off the box.
  const { links } = autoMatch(base, parsedLabels);
  let matchedLabels = 0;
  for (const link of links) {
    if (link.status !== "matched" || link.labelIndex === undefined) continue;
    matchedLabels++;
    const label = parsedLabels[link.labelIndex];
    const order = base.find((o) => o.id === link.orderId);
    if (!order) continue;
    order.trackingRaw = label.trackingRaw ?? order.trackingRaw;
    order.carrierName = label.carrierName ?? order.carrierName;
    order.carrierId = label.carrierId ?? order.carrierId;
  }

  const { orders, linked, withPhoto } = linkCatalog(base, products);
  const lineItems = orders.reduce((s, o) => s + o.items.length, 0);

  return {
    batch: { createdAt: new Date().toISOString(), orders, records: [] },
    stats: {
      orders: orders.length,
      labels: parsedLabels.length,
      matchedLabels,
      lineItems,
      linkedItems: linked,
      itemsWithPhoto: withPhoto,
      catalogProducts: products.length,
    },
  };
}

/**
 * Plain sentence describing what goes in the box, for the spoken announcement.
 *
 * Quantities are only voiced when greater than one — "واحد" before every item
 * makes a long list harder to follow, not easier.
 */
export function describeOrder(order: PackOrder): string {
  const parts = order.items.map((it) => {
    const qty = it.quantity > 1 ? `${it.quantity} ` : "";
    const opt = it.optionText ? `، ${it.optionText}` : "";
    return `${qty}${it.name}${opt}`;
  });
  return parts.join("، و ");
}

/**
 * Signature of what an order physically contains.
 *
 * Used to spot the odd one out when several orders are packed together: if
 * four boxes hold "1 × ماتشا زعفراني 150 جرام" and the fifth holds something
 * else, packing them from one pile is how the wrong item ends up in a box.
 *
 * Built from the resolved catalog name, the chosen variant and the quantity —
 * not the order number — and sorted, so line order never matters.
 */
export function orderSignature(order: PackOrder): string {
  return order.items
    .map((it) => `${foldArabic(it.name)}|${foldArabic(it.optionText ?? "")}|${it.quantity}`)
    .sort()
    .join(" ++ ");
}

/**
 * Splits a set of orders into the dominant contents and any that differ.
 * The majority signature wins; everything else is reported as an outlier.
 */
export function findContentOutliers(orders: PackOrder[]): {
  majority: string;
  /** An order that represents the dominant contents, for explaining diffs. */
  reference?: PackOrder;
  outliers: PackOrder[];
} {
  if (orders.length === 0) return { majority: "", outliers: [] };

  const counts = new Map<string, number>();
  for (const o of orders) {
    const sig = orderSignature(o);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }

  let majority = "";
  let best = -1;
  for (const [sig, n] of counts) {
    if (n > best) {
      best = n;
      majority = sig;
    }
  }

  return {
    majority,
    reference: orders.find((o) => orderSignature(o) === majority),
    outliers: orders.filter((o) => orderSignature(o) !== majority),
  };
}

/**
 * Plain-language reasons an order differs from the rest of the pile.
 *
 * A bare "this one is different" is not actionable at the bench — the packer
 * needs to know it is the extra ملعقة ماتشا, so they can decide in a second
 * whether it matters.
 */
export function explainDifference(order: PackOrder, reference: PackOrder): string[] {
  const key = (it: PackItem) => `${foldArabic(it.name)}|${foldArabic(it.optionText ?? "")}`;
  const label = (it: PackItem) => `${it.name}${it.optionText ? ` (${it.optionText})` : ""}`;

  const mine = new Map(order.items.map((it) => [key(it), it]));
  const theirs = new Map(reference.items.map((it) => [key(it), it]));
  const out: string[] = [];

  if (order.items.length !== reference.items.length) {
    out.push(`عدد الأصناف ${order.items.length} بدل ${reference.items.length}`);
  }

  for (const [k, it] of mine) {
    if (!theirs.has(k)) out.push(`صنف إضافي: ${label(it)}`);
  }
  for (const [k, it] of theirs) {
    if (!mine.has(k)) out.push(`صنف ناقص: ${label(it)}`);
  }
  for (const [k, it] of mine) {
    const other = theirs.get(k);
    if (other && other.quantity !== it.quantity) {
      out.push(`${it.name}: الكمية ${it.quantity} بدل ${other.quantity}`);
    }
  }

  return out.length ? out : ["محتويات مختلفة عن باقي الطلبات"];
}

