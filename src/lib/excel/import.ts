/**
 * Salla product-export importer.
 *
 * The export is a wide, denormalised sheet with two structural quirks that
 * drive most of the logic here:
 *
 *   1. Variant rows (النوع = "خيار") carry no foreign key to their parent.
 *      They inherit it by *row proximity* and share the parent's product name.
 *      Proximity alone is fragile, so parentage is confirmed by name too and
 *      anything that fails both is surfaced rather than silently guessed.
 *
 *   2. Bundle composition exists only as free-text HTML in the description.
 *      It cannot be trusted as structured data, so it is offered as a draft
 *      the merchant confirms — never applied automatically.
 */

import { foldArabic } from "../arabic.ts";
import type { Product, ProductStatus, Variant } from "../catalog-types.ts";
export type { Product } from "../catalog-types.ts";

/** Salla writes this literal for empty numeric cells. */
const NULL_TOKEN = /^\\N$/;

export interface ImportDiagnostics {
  total: number;
  imported: number;
  missingSku: Product[];
  duplicateSku: { sku: string; products: Product[] }[];
  /**
   * Products sharing a display name but holding different SKUs. The order PDF
   * identifies items by name, so these are genuinely ambiguous at packing time
   * — the merchant has to say which row is the one being shipped.
   */
  duplicateName: { name: string; products: Product[] }[];
  missingImage: Product[];
  hidden: Product[];
  bundleCandidates: Product[];
  /** Variant rows whose parent could not be resolved. */
  orphanVariants: { rowIndex: number; name: string }[];
}

export interface ImportResult {
  products: Product[];
  diagnostics: ImportDiagnostics;
}

/** Keywords that suggest a product is really several physical objects. */
const BUNDLE_KEYWORDS = ["بكج", "باقة", "طقم", "عدة", "هدية", "مجموعة", "بكيج"];

const HEADERS = {
  sallaId: "No.",
  rowType: "النوع",
  name: "أسم المنتج",
  categories: "تصنيف المنتج",
  image: "صورة المنتج",
  price: "سعر المنتج",
  stock: "الكمية المتوفرة",
  description: "الوصف",
  sku: "رمز المنتج sku",
  weight: "الوزن",
  weightUnit: "وحدة الوزن",
  status: "حالة المنتج",
  barcode: "الباركود",
  gtin: "GTIN",
} as const;

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s || NULL_TOKEN.test(s)) return undefined;
  return s;
}

function num(v: unknown): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function list(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function mapStatus(v: unknown): ProductStatus {
  const s = str(v);
  if (s === "مخفي") return "hidden";
  if (s === "غير متاح") return "unavailable";
  return "available";
}

/**
 * Finds a column by header name, tolerating the stray leading/trailing spaces
 * Salla ships in its own headers (e.g. " النوع").
 */
function pick(row: Row, header: string): unknown {
  if (header in row) return row[header];
  const key = Object.keys(row).find((k) => k.trim() === header.trim());
  return key ? row[key] : undefined;
}

/** Reads the "[n] الاسم" / "[n] القيمة" option column groups. */
function optionGroups(row: Row): {
  index: number;
  name?: string;
  type?: string;
  value?: string;
  image?: string;
}[] {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const name = str(pick(row, `[${i}] الاسم`));
    const type = str(pick(row, `[${i}] النوع`));
    const value = str(pick(row, `[${i}] القيمة`));
    const image = str(pick(row, `[${i}] الصورة / اللون`));
    if (name || value || image) out.push({ index: i, name, type, value, image });
  }
  return out;
}

export function looksLikeBundle(name: string, categories: string[]): boolean {
  const hay = foldArabic([name, ...categories].join(" "));
  return BUNDLE_KEYWORDS.some((k) => hay.includes(foldArabic(k)));
}

/**
 * Extracts a component draft from a bundle's description HTML.
 *
 * Salla descriptions carry numbered prose ("1- خمسة اظرف قهوة كولمبي"). This is
 * a *suggestion* only: the merchant confirms it in the rule builder before it
 * ever affects a prep summary.
 */
export function draftComponentsFromDescription(
  html: string | undefined,
): { text: string }[] {
  if (!html) return [];
  const plain = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  return plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\s*[-.)]/.test(l))
    .map((l) => ({ text: l.replace(/^\d+\s*[-.)]\s*/, "").trim() }))
    .filter((c) => c.text.length > 1);
}

/**
 * Converts raw sheet rows (already objects keyed by header) into products.
 * `rows` is whatever SheetJS `sheet_to_json` produced, so this stays testable
 * without a spreadsheet library in the loop.
 */
export function importCatalog(rows: Row[]): ImportResult {
  const products: Product[] = [];
  const orphanVariants: ImportDiagnostics["orphanVariants"] = [];

  rows.forEach((row, i) => {
    const rowType = str(pick(row, HEADERS.rowType));
    const name = str(pick(row, HEADERS.name));
    if (!name) return;

    if (rowType === "خيار") {
      // Variants inherit their parent by proximity; confirm by name before
      // attaching, and surface the row instead of guessing when it disagrees.
      const parent = products[products.length - 1];
      const sameName =
        parent && foldArabic(parent.name) === foldArabic(name);
      if (!parent || !sameName) {
        orphanVariants.push({ rowIndex: i + 2, name });
        return;
      }
      for (const g of optionGroups(row)) {
        if (!g.value) continue;
        // The group's display name lives on the parent row, not this one.
        const parentGroup = parent.variants.length
          ? parent.variants[0].groupName
          : (parent as Product & { _groupName?: string })._groupName;
        const variant: Variant = {
          id: `${parent.id}:v${parent.variants.length + 1}`,
          groupName: parentGroup ?? "الخيار",
          groupType: g.image ? "image" : "text",
          value: g.value,
          imageUrl: g.image,
          sku: str(pick(row, HEADERS.sku)),
          price: num(pick(row, HEADERS.price)),
          stock: num(pick(row, HEADERS.stock)),
        };
        parent.variants.push(variant);
      }
      return;
    }

    const categories = list(pick(row, HEADERS.categories));
    const imageUrls = list(pick(row, HEADERS.image));
    const descriptionHtml = str(pick(row, HEADERS.description));
    const groups = optionGroups(row);

    const product: Product & { _groupName?: string } = {
      id: `p${i + 1}`,
      sallaId: str(pick(row, HEADERS.sallaId)),
      name,
      sku: str(pick(row, HEADERS.sku)),
      categories,
      imageUrls,
      descriptionHtml,
      price: num(pick(row, HEADERS.price)),
      stock: num(pick(row, HEADERS.stock)),
      weight: num(pick(row, HEADERS.weight)),
      weightUnit: str(pick(row, HEADERS.weightUnit)),
      barcode: str(pick(row, HEADERS.barcode)),
      gtin: str(pick(row, HEADERS.gtin)),
      status: mapStatus(pick(row, HEADERS.status)),
      variants: [],
      isBundle: looksLikeBundle(name, categories),
      hasBundleRule: false,
      // Carried so the following خيار rows know their group's display name.
      _groupName: groups.find((g) => g.name)?.name,
    };

    products.push(product);
  });

  // Strip the private carrier field before handing products out.
  for (const p of products) {
    delete (p as Product & { _groupName?: string })._groupName;
  }

  const packable = products.filter((p) => p.status !== "hidden");

  const bySku = new Map<string, Product[]>();
  for (const p of packable) {
    if (!p.sku) continue;
    const arr = bySku.get(p.sku) ?? [];
    arr.push(p);
    bySku.set(p.sku, arr);
  }

  const byName = new Map<string, Product[]>();
  for (const p of packable) {
    const key = foldArabic(p.name);
    const arr = byName.get(key) ?? [];
    arr.push(p);
    byName.set(key, arr);
  }

  const diagnostics: ImportDiagnostics = {
    total: products.length,
    imported: packable.length,
    missingSku: packable.filter((p) => !p.sku),
    duplicateSku: [...bySku.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([sku, ps]) => ({ sku, products: ps })),
    duplicateName: [...byName.values()]
      .filter((ps) => ps.length > 1)
      .map((ps) => ({ name: ps[0].name, products: ps })),
    missingImage: packable.filter((p) => p.imageUrls.length === 0),
    hidden: products.filter((p) => p.status === "hidden"),
    bundleCandidates: packable.filter((p) => p.isBundle),
    orphanVariants,
  };

  return { products, diagnostics };
}
