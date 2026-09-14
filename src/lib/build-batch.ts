"use client";

import { readPdfItems } from "./pdf/read-client.ts";
import { parseOrdersFromItems } from "./pdf/orders.ts";
import { parseLabelsFromItems, type ParsedLabel } from "./pdf/labels.ts";
import { readLabelContents } from "./pdf/label-contents.ts";
import { autoMatch } from "./barcode.ts";
import { couldBe, resolveOption } from "./options.ts";
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
  /**
   * Where the order lines came from. "labels" means the orders PDF was absent
   * or unreadable and the boxes were reconstructed from the shipping labels,
   * which is worth saying out loud before packing starts.
   */
  source: "orders-pdf" | "labels";
  /** Label-built lines whose text could not be tied to a catalog product. */
  unreadItems: number;
  /** Label-built lines whose quantity is a guess rather than a figure read. */
  approximateItems: number;
}

/**
 * Raised when a PDF carries no text layer at all.
 *
 * Salla's *invoice* export draws every glyph as vector outlines, so a file
 * that looks perfectly normal on screen yields nothing to any text extractor —
 * not a parser bug, and no amount of fixing the parser will help. The generic
 * "no orders found" message sent the merchant hunting; naming the real cause,
 * and the export that does work, ends it in one read.
 */
export class NoTextLayerError extends Error {
  readonly which: "orders" | "labels";

  constructor(which: "orders" | "labels") {
    super(
      which === "orders"
        ? "ملف الطلبات لا يحتوي على نص — صفحاته صور أو خطوط محوّلة إلى أشكال، فلا يمكن استخراج أي كلمة منه. هذا ما يحدث مع تصدير «الفواتير» من سلة؛ صدّر «تجهيز الطلبات» بدلًا منه، أو تابع بملف البوليصات وحده."
        : "ملف البوليصات لا يحتوي على نص — صفحاته صور أو خطوط محوّلة إلى أشكال، فلا يمكن قراءته.",
    );
    this.name = "NoTextLayerError";
    this.which = which;
  }
}

/** True when not one page of the PDF yielded a single piece of text. */
function hasNoText(pages: { str: string }[][]): boolean {
  return pages.every((page) => page.every((it) => !it.str.trim()));
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

  // Compare with all spaces removed, so a lost space in the PDF
  // ("استكر شيتمن قوت") still finds its product.
  const squashed = folded.replace(/\s+/g, "");
  const loose = products.filter(
    (p) => foldArabic(p.name).replace(/\s+/g, "") === squashed,
  );
  if (loose.length === 1) return loose[0];

  // Last resort: the invoice font has no glyph for some ligatures, so pdf.js
  // hands back U+FFFD in their place — «بكج اليوم الوط �» for «بكج اليوم
  // الوطني». The characters are not recoverable from the PDF, but the catalog
  // knows every legal name, so the damaged string only has to identify one.
  if (item.name.includes("�")) {
    const fits = products.filter((p) => couldBe(item.name, p.name));
    if (fits.length === 1) return fits[0];
  }
  return undefined;
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

/** Marks a line the label could not resolve, so the card can say so. */
const UNMATCHED_NOTE = "لم يُطابَق مع ملف المنتجات";
const APPROX_NOTE = "الكمية غير مؤكدة — راجع الطلب";

/**
 * Builds the orders from the shipping labels alone.
 *
 * Everything the packer needs is on the label: the order number, who it is
 * going to, the barcode that will be scanned, and — in the carrier's
 * description-of-goods field — what belongs in the box. It is a poorer source
 * than the orders PDF (no SKUs, no variant text, quantities read off mangled
 * bidi text) but it is a complete one, and it is what stands between an
 * unreadable export and a wasted afternoon.
 */
function ordersFromLabels(labels: ParsedLabel[], products: Product[]): PackOrder[] {
  return labels.map((label, i) => {
    const items = readLabelContents(label.description ?? "", products);
    const number = label.orderNumberOnLabel ?? label.trackingRaw ?? String(i + 1);
    return {
      id: `l${i + 1}-${number}`,
      orderNumber: number,
      customerName: label.recipientName,
      city: label.city,
      carrierName: label.carrierName,
      carrierId: label.carrierId,
      service: label.service,
      trackingRaw: label.trackingRaw,
      // Only an amount the label presents as cash on delivery makes this an
      // order to collect for. A declared value is what the goods are worth,
      // and reading it as COD would tell the packer to take money twice.
      paymentType: (label.codAmount ?? 0) > 0 ? ("cod" as const) : ("prepaid" as const),
      totalAmount: label.declaredValue ?? label.codAmount,
      items: items.map((it): PackItem => ({
        name: it.name,
        rawName: it.name,
        quantity: it.quantity,
        sku: it.sku,
        sallaProductId: it.sallaProductId,
        // Shown on the card in amber: a guessed quantity must never pass for a
        // read one, and an unmatched name must look unmatched.
        optionText: !it.resolved
          ? UNMATCHED_NOTE
          : it.approximate
            ? APPROX_NOTE
            : undefined,
        optionVerified: false,
      })),
    };
  });
}

function countNotes(orders: PackOrder[], note: string): number {
  return orders.reduce(
    (n, o) => n + o.items.filter((it) => it.optionText === note).length,
    0,
  );
}

export async function buildBatch(
  ordersPdf: File | null,
  labelsPdf: File,
  /** The product list, already loaded — baked in unless the device holds one. */
  products: Product[],
  onProgress?: (p: BuildProgress) => void,
): Promise<{ batch: Batch; stats: BuildStats }> {

  let parsedOrders: ReturnType<typeof parseOrdersFromItems> = [];
  if (ordersPdf) {
    onProgress?.({ stage: "قراءة ملف الطلبات", done: 0, total: 1 });
    const orderPages = await readPdfItems(ordersPdf, (d, t) =>
      onProgress?.({ stage: "قراءة ملف الطلبات", done: d, total: t }),
    );
    if (hasNoText(orderPages.pages)) throw new NoTextLayerError("orders");
    parsedOrders = parseOrdersFromItems(orderPages.pages);
  }

  onProgress?.({ stage: "قراءة ملف البوليصات", done: 0, total: 1 });
  const labelPages = await readPdfItems(labelsPdf, (d, t) =>
    onProgress?.({ stage: "قراءة ملف البوليصات", done: d, total: t }),
  );
  if (hasNoText(labelPages.pages)) throw new NoTextLayerError("labels");
  const parsedLabels = parseLabelsFromItems(labelPages.pages);

  // No orders PDF, or one that parsed to nothing: the labels carry enough to
  // pack from, so they are used rather than refusing the whole batch.
  if (parsedOrders.length === 0) {
    const fromLabels = ordersFromLabels(parsedLabels, products);
    const { orders, linked, withPhoto } = linkCatalog(fromLabels, products);
    return {
      batch: { createdAt: new Date().toISOString(), orders, records: [] },
      stats: {
        orders: orders.length,
        labels: parsedLabels.length,
        // Every order here *is* a label, so the match is total by construction.
        matchedLabels: parsedLabels.length,
        lineItems: orders.reduce((n, o) => n + o.items.length, 0),
        linkedItems: linked,
        itemsWithPhoto: withPhoto,
        catalogProducts: products.length,
        source: "labels",
        unreadItems: countNotes(orders, UNMATCHED_NOTE),
        approximateItems: countNotes(orders, APPROX_NOTE),
      },
    };
  }

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
      // Keeps the font's damage, so the catalog can read through it.
      rawName: it.nameRaw || it.name,
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
    // Only the label knows whether SMSA is delivering to the door or holding
    // the parcel at a branch, and the two cost very different amounts.
    order.service = label.service ?? order.service;
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
      source: "orders-pdf",
      unreadItems: 0,
      approximateItems: 0,
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

/**
 * Checks a freshly scanned order against the ones already handled in a
 * session, and explains any difference.
 *
 * Used by the photo flow, where boxes are scanned one at a time rather than
 * collected up front: the first order sets what the session is, and every
 * later scan has to hold the same thing. Returns an empty list when it
 * matches, so the caller can treat "no reasons" as "carry on".
 */
export function differsFromSession(order: PackOrder, session: PackOrder[]): string[] {
  const reference = session[0];
  if (!reference || reference.id === order.id) return [];
  if (orderSignature(order) === orderSignature(reference)) return [];
  return explainDifference(order, reference);
}
