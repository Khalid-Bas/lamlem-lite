import { foldArabic } from "../arabic.ts";
import { reconstructText, type RawItem } from "./layout.ts";
import type { Product } from "../catalog-types.ts";

/**
 * Reading what is in the box off the shipping label itself.
 *
 * Salla prints the order's contents in the carrier's "description of goods"
 * field — «بكج الماتشا (1) ،بكج القهوة مع مق (1)» — which makes the label a
 * complete fallback when the orders PDF cannot be read at all. That happens
 * for real: Salla's *invoice* export draws every glyph as vector outlines, so
 * it carries no text layer and nothing can be extracted from it.
 *
 * The text comes out mangled. It is the smallest type on the label, it mixes
 * Arabic with Latin runs ("شاي ماتشا 150g"), and the bidi reordering leaves
 * brackets mirrored and the odd token out of place — «شاي ماتشا (150g (1».
 * So the names are never trusted as strings: they are matched against the
 * catalog by token, which survives all of that.
 */

const ARABIC = /[؀-ۿﭐ-﷿ﹰ-﻿]/;

/**
 * Pulls the description block out of a label's positioned text.
 *
 * The block is set in the smallest type on the label — smaller than the
 * address, the tracking number and the routing code — so it is found by font
 * size rather than by position, which differs from carrier to carrier. Picking
 * the band by size also drops the routing code stamped across the middle of
 * it, which is set much larger and would otherwise land in the text.
 */
export function extractDescription(items: RawItem[]): string {
  const usable = items.filter((i) => i.str.trim());
  const arabic = usable.filter((i) => ARABIC.test(i.str));
  if (arabic.length === 0) return "";

  // Fall back to the transform's vertical scale where pdf.js reports no
  // height, so a label is never silently skipped over a missing field.
  const size = (i: RawItem) => Math.round(i.height ?? Math.abs(i.transform[3] ?? 0));
  const smallest = Math.min(...arabic.map(size));
  const band = usable.filter((i) => size(i) === smallest);
  return reconstructText(band).replace(/\s+/g, " ").trim();
}

export interface LabelItem {
  name: string;
  quantity: number;
  sku?: string;
  sallaProductId?: string;
  /** False when the text could not be tied to a catalog product. */
  resolved: boolean;
  /** True when the quantity is a guess rather than a figure that was read. */
  approximate?: boolean;
}

/** Letters and digits only, so brackets and commas cannot break a match. */
function tokens(s: string): string[] {
  return foldArabic(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Removes a product name's tokens from the bag, or returns null if the bag
 * does not contain all of them. What is left over is the interesting part: it
 * is where the quantity lives.
 */
function consume(bag: string[], name: string): string[] | null {
  const rest = [...bag];
  for (const t of tokens(name)) {
    const at = rest.indexOf(t);
    if (at === -1) return null;
    rest.splice(at, 1);
  }
  return rest;
}

/** The most specific product whose every token appears in the bag. */
function bestMatch(
  bag: string[],
  products: Product[],
): { product: Product; rest: string[] } | null {
  let best: { product: Product; rest: string[]; len: number } | null = null;
  for (const product of products) {
    const len = tokens(product.name).length;
    if (len === 0 || (best && len <= best.len)) continue;
    const rest = consume(bag, product.name);
    if (rest) best = { product, rest, len };
  }
  return best ? { product: best.product, rest: best.rest } : null;
}

/**
 * The quantity is whatever number is left once the product name is accounted
 * for. "شاي ماتشا (150g (1" leaves "1" behind after «شاي ماتشا 150g» is taken
 * out — the 150 never looks like a quantity because it is part of the token
 * "150g". Nothing left over means one, which is what an unmarked line means.
 */
function leftoverQuantity(rest: string[]): number | null {
  const numbers = rest
    .map((t) => (/^\d+$/.test(t) ? Number(t) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? numbers[numbers.length - 1] : null;
}

function asItem(product: Product, quantity: number, approximate?: boolean): LabelItem {
  return {
    name: product.name,
    quantity,
    sku: product.sku,
    sallaProductId: product.sallaId,
    resolved: true,
    approximate,
  };
}

/**
 * Reads the description into order lines, using the catalog as the authority
 * on what the names actually are.
 *
 * Salla separates the lines with an Arabic comma, so each comma-separated
 * chunk normally holds exactly one product and its quantity. When the bidi
 * reordering has thrown a token across a comma the chunks stop matching, and
 * the whole description is then matched greedily instead — that recovers the
 * products, but the pairing of quantities to lines is no longer trustworthy,
 * so they are marked approximate rather than quietly reported as read.
 */
export function readLabelContents(
  description: string,
  products: Product[],
): LabelItem[] {
  if (!description.trim() || products.length === 0) return [];

  const chunks = description
    .split(/[،,]/)
    .map((c) => c.trim())
    .filter(Boolean);

  const byChunk: LabelItem[] = [];
  let allResolved = true;
  for (const chunk of chunks) {
    const hit = bestMatch(tokens(chunk), products);
    if (!hit) {
      allResolved = false;
      byChunk.push({ name: chunk, quantity: 1, resolved: false });
      continue;
    }
    byChunk.push(asItem(hit.product, leftoverQuantity(hit.rest) ?? 1));
  }
  if (allResolved && byChunk.length > 0) return byChunk;

  // Fall back to reading the description as one run.
  let bag = tokens(description);
  const found: Product[] = [];
  for (;;) {
    const hit = bestMatch(bag, products);
    if (!hit) break;
    found.push(hit.product);
    bag = hit.rest;
  }
  if (found.length === 0) return byChunk;

  // Every leftover number agreeing is the only case where a quantity can still
  // be stated with confidence; otherwise each line is reported as one, flagged.
  const numbers = bag.filter((t) => /^\d+$/.test(t)).map(Number).filter((n) => n > 0);
  const agreed =
    numbers.length === found.length && numbers.every((n) => n === numbers[0])
      ? numbers[0]
      : null;

  return found.map((p) => asItem(p, agreed ?? 1, agreed === null));
}
