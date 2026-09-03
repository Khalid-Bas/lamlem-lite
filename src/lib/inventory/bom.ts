import { foldArabic } from "../arabic.ts";

/**
 * The bill of materials: what physically leaves the shelf for each thing sold.
 *
 * A sale is not a stock movement. Selling one «بكج الجمعات» consumes a large
 * carton, ten printed cups, four sticker sheets, a card, a matcha tin and a
 * litre of oat drink — none of which is called "بكج الجمعات" anywhere in the
 * warehouse. Counting sold products alone would leave the packaging and the
 * loose components silently unaccounted for, which is exactly the stock that
 * runs out unnoticed.
 *
 * The matrix comes from the merchant's own sheet: one row per sellable
 * product, one column per component, the cell being how many of that component
 * a single unit consumes.
 */

export interface BomComponent {
  name: string;
  /** Units consumed per one unit of the product sold. */
  qty: number;
}

export interface BomRow {
  /** Product name exactly as the catalog spells it. */
  name: string;
  /**
   * Variant this row is specific to, when the sheet splits a product by option
   * — «اسود/مشروب اوتسايد» for a bundle sold in four combinations. Empty for
   * rows that cover the product outright.
   */
  variant?: string;
  sku?: string;
  components: BomComponent[];
}

export interface Bom {
  rows: BomRow[];
  /**
   * Every component the sheet knows, in column order. The merchant grouped the
   * columns deliberately — cartons, then cups, then stickers, then cards, then
   * the goods themselves — and a stocktake is far easier to walk when the
   * printed list keeps that order instead of re-sorting it alphabetically.
   */
  components: string[];
}

/** Header labels of the three identity columns, before the components start. */
const ID_HEADERS = ["#", "المنتج", "sku"];

/**
 * Reads the consumption matrix out of a workbook sheet given as rows of cells.
 *
 * Layout: row 0 is the header, columns 0–2 identify the product, and every
 * column after that is one component. The same component may appear in more
 * than one column — the sheet has «استكر شيت من تصميم قوت (قهوة)» twice — so
 * columns sharing a name are summed rather than one shadowing the other.
 */
export function parseBom(rows: unknown[][]): Bom {
  if (rows.length < 2) return { rows: [], components: [] };

  const header = (rows[0] ?? []).map((c) => String(c ?? "").trim());
  const firstComponent = header.findIndex(
    (h, i) => i >= ID_HEADERS.length && h.length > 0,
  );
  const start = firstComponent === -1 ? ID_HEADERS.length : firstComponent;

  const components: string[] = [];
  for (let c = start; c < header.length; c++) {
    const label = header[c];
    if (label && !components.includes(label)) components.push(label);
  }

  const out: BomRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const full = String(row[1] ?? "").trim();
    if (!full) continue;

    const byName = new Map<string, number>();
    for (let c = start; c < header.length; c++) {
      const label = header[c];
      if (!label) continue;
      const qty = Number(row[c]);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      byName.set(label, (byName.get(label) ?? 0) + qty);
    }

    // "بكج الجمعات - اسود/مشروب اوتسايد" is one variant of one product, while
    // "بكج القهوة - أثيوبي وكولومبي" is a product whose own name contains a
    // dash. They cannot be told apart here, so the split is left to matching
    // time, where the catalog name is known.
    out.push({
      name: full,
      sku: String(row[2] ?? "").trim() || undefined,
      components: [...byName].map(([name, qty]) => ({ name: name.trim(), qty })),
    });
  }
  return { rows: out, components };
}

/** Reads the matrix from a workbook file the merchant uploads. */
export async function readBomFile(file: File): Promise<Bom> {
  const XLSX = await import("xlsx");
  const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || file.type === "text/csv";
  const wb = isCsv
    ? XLSX.read((await file.text()).replace(/^\ufeff/, ""), { type: "string", raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });

  // The merchant's workbook keeps the price list on the first sheet and the
  // matrix on the second, so the matrix is found by shape, not by position:
  // it is the sheet whose header row names a product column.
  let best: Bom = { rows: [], components: [] };
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });
    const header = (rows[0] ?? []).map((c) => foldArabic(String(c ?? "")));
    if (!header.includes("المنتج")) continue;
    const parsed = parseBom(rows);
    if (parsed.components.length > best.components.length) best = parsed;
  }

  if (best.rows.length === 0) {
    throw new Error("لم يُعثر على جدول المكوّنات — يجب أن يحتوي على عمود «المنتج»");
  }
  return best;
}
