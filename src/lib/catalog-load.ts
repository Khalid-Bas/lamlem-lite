"use client";

import { importCatalog } from "./excel/import.ts";
import type { Product } from "./catalog-types.ts";

/**
 * Reads a Salla product export, whether it is .xlsx or .csv.
 *
 * CSV needs decoding before parsing rather than being handed over as bytes:
 * SheetJS guesses a single-byte codepage for raw CSV input, which turns Arabic
 * product names into mojibake and silently breaks every name match. Decoding as
 * UTF-8 first (and stripping the BOM Excel likes to add) keeps them intact.
 */
export async function readCatalog(file: File): Promise<Product[]> {
  const XLSX = await import("xlsx");
  const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || file.type === "text/csv";

  // raw:true keeps cell values unformatted. With formatting on, SheetJS renders
  // long ids with thousands separators ("102,413,538"), which silently breaks
  // every product-id match and leaves items with no photo.
  const wb = isCsv
    ? XLSX.read((await file.text()).replace(/^﻿/, ""), { type: "string", raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });

  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("الملف لا يحتوي على أي ورقة بيانات");

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  return importCatalog(rows).products;
}
