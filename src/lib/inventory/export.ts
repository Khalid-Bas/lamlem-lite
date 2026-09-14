"use client";

import { dayFolderName, shortDay, safeFileName } from "../drive.ts";
import type { PackOrder } from "../types.ts";
import type { Product } from "../catalog-types.ts";
import type { Settings } from "../settings.ts";
import type { Bom } from "./bom.ts";
import { tally } from "./tally.ts";
import { buildProfitReport } from "./profit.ts";

/**
 * Writes the stocktake as one workbook with three sheets.
 *
 * Three sheets rather than three files because the questions are asked
 * together: what was sold, what to take off the shelves for it, and what the
 * day actually earned once VAT, shipping and cost of goods are out of it.
 */

type Cell = string | number;

const SOLD_HEADER = [
  "#",
  "المنتج",
  "الخيار",
  "SKU",
  "رقم المنتج في سلة",
  "الكمية المباعة",
  "عدد الطلبات",
  "ملاحظة",
];

const USED_HEADER = ["#", "المادة المستهلكة", "الكمية"];

const SALES_HEADER = [
  "#",
  "رقم الطلب",
  "العميل",
  "الشحن",
  "المبلغ المدفوع",
  "صافي المبيعات",
  "ضريبة القيمة المضافة",
  "تكلفة الشحن",
  "تكلفة المنتجات",
  "إجمالي التكلفة",
  "صافي الربح",
  "نسبة الربح",
  "ملاحظة",
];

/** Column widths in characters, so nothing arrives as ###. */
const SOLD_WIDTHS = [5, 44, 26, 16, 16, 14, 12, 30];
const USED_WIDTHS = [5, 44, 12];
const SALES_WIDTHS = [5, 14, 22, 22, 15, 15, 20, 13, 16, 15, 13, 11, 34];

/** Two decimals, the way money is read. */
const money = (n: number): number => Math.round(n * 100) / 100;

async function sheetOf(
  rows: Cell[][],
  widths: number[],
  /** Columns to format as a percentage rather than a plain number. */
  percentCols: number[] = [],
) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  for (const c of percentCols) {
    for (let r = 1; r < rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ c, r })];
      // Written as a fraction and formatted as a percentage, so the sheet can
      // still be summed and sorted on it rather than on a string.
      if (cell && typeof cell.v === "number") cell.z = "0.0%";
    }
  }
  // The filter covers the header and the data, never the totals row — a total
  // that hides when the sheet is filtered is worse than no filter.
  if (rows.length > 2) {
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: { c: widths.length - 1, r: rows.length - 2 },
    }) };
  }
  return ws;
}

export interface InventoryWorkbook {
  blob: Blob;
  fileName: string;
  /** Sold lines the matrix could not cost, so the UI can say so out loud. */
  unresolved: string[];
  soldCount: number;
  componentCount: number;
  /** Net profit across the batch, and what the figure had to assume. */
  netProfit: number;
  netSales: number;
  /** Products sold here that carry no cost price, so the profit is overstated. */
  uncosted: string[];
}

export async function buildInventoryWorkbook(
  orders: PackOrder[],
  bom: Bom,
  products: Product[],
  prefs: Pick<Settings, "vatPercent" | "shipping">,
  when = new Date(),
): Promise<InventoryWorkbook> {
  const XLSX = await import("xlsx");
  const t = tally(orders, bom);
  const p = buildProfitReport(orders, products, prefs);

  const soldRows: Cell[][] = [
    SOLD_HEADER,
    ...t.sold.map((s, i): Cell[] => [
      i + 1,
      s.name,
      s.option ?? "",
      s.sku ?? "",
      s.sallaProductId ?? "",
      s.quantity,
      s.orders,
      s.note ?? "",
    ]),
    [
      "",
      "الإجمالي",
      "",
      "",
      "",
      t.sold.reduce((n, s) => n + s.quantity, 0),
      t.orderCount,
      "",
    ],
  ];

  const usedRows: Cell[][] = [
    USED_HEADER,
    ...t.components.map((c, i): Cell[] => [i + 1, c.name, c.quantity]),
    ["", "الإجمالي", t.components.reduce((n, c) => n + c.quantity, 0)],
  ];

  const salesRows: Cell[][] = [
    SALES_HEADER,
    ...p.orders.map((r, i): Cell[] => [
      i + 1,
      r.orderNumber,
      r.customerName ?? "",
      r.serviceLabel,
      money(r.total),
      money(r.netSales),
      money(r.vat),
      money(r.shippingCost),
      money(r.productCost),
      money(r.totalCost),
      money(r.netProfit),
      r.margin,
      r.note ?? "",
    ]),
    [
      "",
      "الإجمالي",
      "",
      "",
      money(p.totals.total),
      money(p.totals.netSales),
      money(p.totals.vat),
      money(p.totals.shippingCost),
      money(p.totals.productCost),
      money(p.totals.totalCost),
      money(p.totals.netProfit),
      p.totals.margin,
      p.uncosted.length ? `بلا سعر تكلفة: ${p.uncosted.join("، ")}` : "",
    ],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await sheetOf(soldRows, SOLD_WIDTHS), "المنتجات المباعة");
  XLSX.utils.book_append_sheet(wb, await sheetOf(usedRows, USED_WIDTHS), "المواد المستهلكة");
  // The margin column is the last but one, and reads as a percentage.
  XLSX.utils.book_append_sheet(
    wb,
    await sheetOf(salesRows, SALES_WIDTHS, [SALES_HEADER.length - 2]),
    "المبيعات والأرباح",
  );
  // Right-to-left is a workbook-level view flag, not a per-sheet one. Without
  // it Excel opens column A on the left and the whole Arabic table reads
  // backwards.
  wb.Workbook = { ...wb.Workbook, Views: [{ RTL: true }] };
  wb.Props = {
    Title: "جرد الكميات",
    Subject: `${t.orderCount} طلب — ${dayFolderName(when)}`,
  };

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return {
    blob: new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    // "جرد الكميات - 10 Sep - 35 طلب - 9 منتج" — the date first because that is
    // how a folder of these sorts and how the merchant looks for one.
    fileName: `${safeFileName(
      `جرد الكميات - ${shortDay(when)} - ${t.orderCount} طلب - ${t.sold.length} منتج`,
    )}.xlsx`,
    unresolved: t.unresolved.map((s) => `${s.name}${s.option ? ` (${s.option})` : ""}`),
    soldCount: t.sold.length,
    componentCount: t.components.length,
    netProfit: money(p.totals.netProfit),
    netSales: money(p.totals.netSales),
    uncosted: p.uncosted,
  };
}

/** Builds the workbook and hands it to the browser as a download. */
export async function downloadInventory(
  orders: PackOrder[],
  bom: Bom,
  products: Product[],
  prefs: Pick<Settings, "vatPercent" | "shipping">,
): Promise<InventoryWorkbook> {
  const book = await buildInventoryWorkbook(orders, bom, products, prefs);
  const url = URL.createObjectURL(book.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = book.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return book;
}
