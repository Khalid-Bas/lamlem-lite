"use client";

import { readPdfItems } from "./pdf/read-client.ts";
import { parseOrdersFromItems } from "./pdf/orders.ts";
import { parseLabelsFromItems } from "./pdf/labels.ts";
import { autoMatch } from "./barcode.ts";
import { importCatalog } from "./excel/import.ts";
import { foldArabic } from "./arabic.ts";
import type { Batch, PackItem, PackOrder } from "./types.ts";
import type { Product } from "./excel/import.ts";

/**
 * Turns the three uploads into one packable batch, entirely in the browser.
 *
 * Everything happens on the device: the PDFs hold customer names, phone
 * numbers and addresses, and none of it needs to leave the phone for the app
 * to do its job.
 */

export interface BuildProgress {
  stage: string;
  done: number;
  total: number;
}

/** Resolves an order line to a catalog product, best signal first. */
function findProduct(
  item: { sallaProductId?: string; sku?: string; name: string },
  products: Product[],
): Product | undefined {
  if (item.sallaProductId) {
    const hit = products.find((p) => p.sallaId === item.sallaProductId);
    if (hit) return hit;
  }
  if (item.sku) {
    const hit = products.find((p) => p.sku === item.sku);
    if (hit) return hit;
  }
  const folded = foldArabic(item.name);
  const exact = products.filter((p) => foldArabic(p.name) === folded);
  if (exact.length === 1) return exact[0];

  // The PDF sometimes loses a space between words ("استكر شيتمن تصميم قوت"),
  // so fall back to comparing with all spaces removed.
  const squashed = folded.replace(/\s+/g, "");
  const loose = products.filter(
    (p) => foldArabic(p.name).replace(/\s+/g, "") === squashed,
  );
  return loose.length === 1 ? loose[0] : undefined;
}

export async function buildBatch(
  ordersPdf: File,
  labelsPdf: File,
  catalogXlsx: File | null,
  onProgress?: (p: BuildProgress) => void,
): Promise<Batch> {
  let products: Product[] = [];
  if (catalogXlsx) {
    onProgress?.({ stage: "قراءة ملف المنتجات", done: 0, total: 1 });
    const XLSX = await import("xlsx");
    const buf = await catalogXlsx.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
    });
    products = importCatalog(rows).products;
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

  const orders: PackOrder[] = parsedOrders.map((o, i) => ({
    id: `o${i + 1}-${o.orderNumber}`,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    city: o.city,
    carrierName: o.carrierName,
    trackingRaw: o.trackingRaw,
    paymentType: o.paymentType,
    totalAmount: o.totalAmount,
    items: o.items.map((it): PackItem => {
      const p = findProduct(it, products);
      return {
        name: p?.name ?? it.name,
        quantity: it.quantity,
        imageUrl: p?.imageUrls[0],
        optionText: it.optionText,
        sku: it.sku,
      };
    }),
  }));

  // The label is the authority on the tracking number — it is the barcode that
  // will actually be scanned off the box.
  const { links } = autoMatch(orders, parsedLabels);
  for (const link of links) {
    if (link.status !== "matched" || link.labelIndex === undefined) continue;
    const label = parsedLabels[link.labelIndex];
    const order = orders.find((o) => o.id === link.orderId);
    if (!order) continue;
    order.trackingRaw = label.trackingRaw ?? order.trackingRaw;
    order.carrierName = label.carrierName ?? order.carrierName;
  }

  return { createdAt: new Date().toISOString(), orders, records: [] };
}
