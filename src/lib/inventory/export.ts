"use client";

import { dayFolderName, safeFileName } from "../drive.ts";
import type { PackOrder } from "../types.ts";
import type { Bom } from "./bom.ts";
import { tally } from "./tally.ts";

/**
 * Writes the stocktake as one workbook with two sheets.
 *
 * Two sheets rather than two files because the questions are asked together:
 * the first says what was sold, the second says what to take off the shelves
 * for it, and comparing them is the whole point.
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

/** Column widths in characters, so nothing arrives as ###. */
const SOLD_WIDTHS = [5, 44, 26, 16, 16, 14, 12, 30];
const USED_WIDTHS = [5, 44, 12];

async function sheetOf(rows: Cell[][], widths: number[]) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
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
}

export async function buildInventoryWorkbook(
  orders: PackOrder[],
  bom: Bom,
  when = new Date(),
): Promise<InventoryWorkbook> {
  const XLSX = await import("xlsx");
  const t = tally(orders, bom);

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

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await sheetOf(soldRows, SOLD_WIDTHS), "المنتجات المباعة");
  XLSX.utils.book_append_sheet(wb, await sheetOf(usedRows, USED_WIDTHS), "المواد المستهلكة");
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
    fileName: `${safeFileName(`جرد الكميات - ${t.orderCount} طلب - ${dayFolderName(when)}`)}.xlsx`,
    unresolved: t.unresolved.map((s) => `${s.name}${s.option ? ` (${s.option})` : ""}`),
    soldCount: t.sold.length,
    componentCount: t.components.length,
  };
}

/** Builds the workbook and hands it to the browser as a download. */
export async function downloadInventory(
  orders: PackOrder[],
  bom: Bom,
): Promise<InventoryWorkbook> {
  const book = await buildInventoryWorkbook(orders, bom);
  const url = URL.createObjectURL(book.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = book.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return book;
}
