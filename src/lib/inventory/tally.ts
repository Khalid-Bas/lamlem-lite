import { foldArabic } from "../arabic.ts";
import { sameId } from "../build-batch.ts";
import type { PackOrder } from "../types.ts";
import type { Bom, BomRow } from "./bom.ts";

/**
 * Turns a batch of orders into a stocktake: what was sold, and what that
 * actually costs the shelves.
 *
 * Two questions, deliberately answered separately. «كم بعت؟» is about the
 * catalog and is answered by counting order lines. «كم أنقص من المخزون؟» is
 * about physical goods, and a bundle answers it with a list of things whose
 * names never appear on any order.
 */

export interface SoldLine {
  name: string;
  /** Chosen variant, when the product has options. */
  option?: string;
  sku?: string;
  sallaProductId?: string;
  /** Units sold across the whole batch. */
  quantity: number;
  /** How many orders that quantity is spread over. */
  orders: number;
  /** Set when the line could not be costed against the matrix. */
  note?: string;
}

export interface ComponentLine {
  name: string;
  quantity: number;
}

export interface Tally {
  sold: SoldLine[];
  components: ComponentLine[];
  /** Sold lines with no usable row in the matrix, repeated for visibility. */
  unresolved: SoldLine[];
  orderCount: number;
}

const NO_ROW = "غير موجود في ملف الجرد";
const NO_COMPONENTS = "لا توجد مكوّنات في ملف الجرد";
const AMBIGUOUS = "أكثر من صف مطابق في ملف الجرد";

/** Splits "بكج الجمعات - اسود/مشروب اوتلي" into its base name and variant. */
function variantOf(row: BomRow, productName: string): string | null {
  const prefix = `${foldArabic(productName)} - `;
  const folded = foldArabic(row.name);
  return folded.startsWith(prefix) ? row.name.slice(productName.length + 3).trim() : null;
}

/**
 * How well a matrix variant matches the option chosen on the order.
 *
 * The sheet writes a variant as slash-joined values — «اسود/مشروب اوتسايد» —
 * while the order carries a labelled option — «نوع الحليب: مشروب اوتسايد».
 * Only some of those values are options the customer picked; the rest describe
 * a distinction the catalog does not expose at all (the carton colour, whose
 * rows are identical anyway). So the score counts the values that do appear
 * and never requires all of them.
 */
function variantScore(variant: string, optionText: string): number {
  const opt = foldArabic(optionText);
  if (!opt) return 0;
  return variant
    .split(/[/،,·]/)
    .map((v) => foldArabic(v).trim())
    .filter(Boolean)
    .filter((v) => opt.includes(v)).length;
}

/** True when two rows would consume exactly the same things. */
function sameComponents(a: BomRow, b: BomRow): boolean {
  const key = (r: BomRow) =>
    r.components
      .map((c) => `${foldArabic(c.name)}=${c.qty}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

/**
 * Finds the matrix row for a sold line.
 *
 * SKU first: the sheet lists «استكر شيت من تصميم قوت» three times for three
 * different printings, and only the SKU tells them apart. Name is the fallback
 * for the rows the sheet leaves without one, and the variant rows are reached
 * by prefix because their names carry the option inline.
 */
export function matchBomRow(
  line: { name: string; option?: string; sku?: string },
  bom: Bom,
): { row?: BomRow; note?: string } {
  if (line.sku) {
    const bySku = bom.rows.filter((r) => sameId(r.sku, line.sku));
    if (bySku.length === 1) return { row: bySku[0] };
    if (bySku.length > 1) {
      return bySku.every((r) => sameComponents(r, bySku[0]))
        ? { row: bySku[0] }
        : { row: bySku[0], note: AMBIGUOUS };
    }
  }

  const folded = foldArabic(line.name);
  const byName = bom.rows.filter((r) => foldArabic(r.name) === folded);
  if (byName.length === 1) return { row: byName[0] };
  if (byName.length > 1) {
    return byName.every((r) => sameComponents(r, byName[0]))
      ? { row: byName[0] }
      : { row: byName[0], note: AMBIGUOUS };
  }

  const variants = bom.rows
    .map((row) => ({ row, variant: variantOf(row, line.name) }))
    .filter((v): v is { row: BomRow; variant: string } => v.variant !== null);
  if (variants.length === 0) return {};

  const scored = variants
    .map((v) => ({ ...v, score: variantScore(v.variant, line.option ?? "") }))
    .sort((a, b) => b.score - a.score);

  const top = scored.filter((v) => v.score === scored[0].score);
  if (top.length === 1) return { row: top[0].row };
  // Several rows fit equally well. Harmless when they consume the same things
  // — the sheet splits «بكج الجمعات» by a carton colour the order never states
  // — and worth flagging when they do not.
  return top.every((v) => sameComponents(v.row, top[0].row))
    ? { row: top[0].row }
    : { row: top[0].row, note: AMBIGUOUS };
}

/** Groups the batch's order lines into one row per product-and-variant. */
export function tallySold(orders: PackOrder[]): SoldLine[] {
  const byKey = new Map<string, SoldLine & { orderIds: Set<string> }>();

  for (const order of orders) {
    for (const item of order.items) {
      const key = `${foldArabic(item.name)}|${foldArabic(item.optionText ?? "")}`;
      const seen = byKey.get(key);
      if (seen) {
        seen.quantity += item.quantity;
        seen.orderIds.add(order.id);
        continue;
      }
      byKey.set(key, {
        name: item.name,
        option: item.optionText,
        sku: item.sku,
        sallaProductId: item.sallaProductId,
        quantity: item.quantity,
        orders: 0,
        orderIds: new Set([order.id]),
      });
    }
  }

  return [...byKey.values()]
    .map(({ orderIds, ...line }) => ({ ...line, orders: orderIds.size }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "ar"));
}

/** Sold products plus the components they consume, ready to write to a sheet. */
export function tally(orders: PackOrder[], bom: Bom): Tally {
  const sold = tallySold(orders);
  const used = new Map<string, number>();
  const unresolved: SoldLine[] = [];

  for (const line of sold) {
    const { row, note } = matchBomRow(line, bom);
    if (!row) {
      line.note = NO_ROW;
      unresolved.push(line);
      continue;
    }
    if (row.components.length === 0) {
      line.note = NO_COMPONENTS;
      unresolved.push(line);
      continue;
    }
    if (note) line.note = note;
    for (const c of row.components) {
      used.set(c.name, (used.get(c.name) ?? 0) + c.qty * line.quantity);
    }
  }

  // Column order from the sheet, so the printed list walks the shelves the way
  // the merchant grouped them; anything the sheet does not list falls in after.
  const order = new Map(bom.components.map((n, i) => [foldArabic(n), i]));
  const components = [...used]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => {
      const ia = order.get(foldArabic(a.name)) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(foldArabic(b.name)) ?? Number.MAX_SAFE_INTEGER;
      return ia - ib || a.name.localeCompare(b.name, "ar");
    });

  return { sold, components, unresolved, orderCount: orders.length };
}
