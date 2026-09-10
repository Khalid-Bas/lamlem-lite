import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDescription, readLabelContents } from "../src/lib/pdf/label-contents.ts";
import { parseLabelPages } from "../src/lib/pdf/labels.ts";
import type { Product } from "../src/lib/catalog-types.ts";
import type { RawItem } from "../src/lib/pdf/layout.ts";

/**
 * Reading the order off the shipping label.
 *
 * The strings here are real output from a Salla/SMSA label — mangled exactly
 * as the bidi reordering leaves them, mirrored brackets and all — because the
 * whole point of matching by token is surviving that, and a tidied-up fixture
 * would test nothing.
 */

const catalog: Product[] = [
  "شاي ماتشا 150g",
  "بكج الماتشا",
  "بكج القهوة مع مق",
  "بكج القهوة - أثيوبي وكولومبي",
  "10 أكواب ورقية من تصميم قوت",
  "بكج ال 99",
  "5 أظرف قهوة التقطير المختصة أثيوبية قوت",
  "ماتشا احتفالية فاخرة 50 جرام",
].map((name, i) => ({
  id: `p${i}`,
  sallaId: `${1000 + i}`,
  sku: `S${i}`,
  name,
  categories: [],
  imageUrls: [],
  status: "available",
  variants: [],
  isBundle: false,
  hasBundleRule: false,
}));

const names = (items: { name: string }[]) => items.map((i) => i.name);

/* ── finding the description block ── */

const item = (str: string, x: number, y: number, height: number): RawItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width: str.length * 4,
  height,
});

test("takes the smallest type on the label and leaves the rest alone", () => {
  // The routing code is stamped across the description in much larger type;
  // taking a y-band would swallow it, taking the font size does not.
  const description = extractDescription([
    item("Ship to: 966543773331", 19, 291, 10),
    item("Saudi Arabia", 223, 226, 8),
    item("بكج الماتشا", 240, 211, 7),
    item("(1)", 230, 211, 7),
    item("GIX 118 A", 51, 207, 12),
    item("MASTER#: 2917 0132 2580", 51, 134, 10),
  ]);
  assert.equal(description.includes("بكج الماتشا"), true);
  assert.equal(description.includes("GIX"), false);
  assert.equal(description.includes("MASTER"), false);
});

test("a label with no Arabic at all yields no description", () => {
  assert.equal(extractDescription([item("MASTER#: 2917", 51, 134, 10)]), "");
});

/* ── turning the description into order lines ── */

test("reads several products and their quantities off one label", () => {
  const items = readLabelContents(
    "بكج الماتشا (1) ،بكج القهوة مع مق (1) ،بكج القهوة - أثيوبي وكولومبي (1) ، 10 أكواب ورقية من تصميم قوت 1)",
    catalog,
  );
  assert.deepEqual(names(items), [
    "بكج الماتشا",
    "بكج القهوة مع مق",
    "بكج القهوة - أثيوبي وكولومبي",
    "10 أكواب ورقية من تصميم قوت",
  ]);
  assert.deepEqual(items.map((i) => i.quantity), [1, 1, 1, 1]);
  assert.equal(items.every((i) => i.resolved && !i.approximate), true);
});

test("a Latin run inside the name survives the mirrored brackets", () => {
  // "شاي ماتشا 150g (1)" comes out of the PDF as "شاي ماتشا (150g (1".
  const [item] = readLabelContents("شاي ماتشا (150g (1", catalog);
  assert.equal(item.name, "شاي ماتشا 150g");
  assert.equal(item.quantity, 1);
  assert.equal(item.resolved, true);
});

test("the 150 in 150g is never mistaken for a quantity", () => {
  const [item] = readLabelContents("شاي ماتشا (150g (4", catalog);
  assert.equal(item.name, "شاي ماتشا 150g");
  assert.equal(item.quantity, 4);
});

test("a quantity printed mid-name still reads as the quantity", () => {
  // "بكج ال 99 (1)" arrives as "بكج ال (1) 99" — the 99 belongs to the name.
  const [item] = readLabelContents("بكج ال (1) 99", catalog);
  assert.equal(item.name, "بكج ال 99");
  assert.equal(item.quantity, 1);
});

test("recovers both products when a token is thrown across the comma", () => {
  // Real page: the 5 and the 150g swapped sides of the separator, so neither
  // chunk matches on its own and the whole line has to be read as one run.
  const items = readLabelContents(
    "شاي ماتشا 5 ، 150g (1) أظرف قهوة التقطير المختصة أثيوبية قوت (1)",
    catalog,
  );
  assert.deepEqual(names(items).sort(), [
    "5 أظرف قهوة التقطير المختصة أثيوبية قوت",
    "شاي ماتشا 150g",
  ]);
  assert.equal(items.every((i) => i.resolved), true);
  // Both quantities read as 1 and agreed, so they are not flagged as guesses.
  assert.deepEqual(items.map((i) => i.quantity), [1, 1]);
  assert.equal(items.some((i) => i.approximate), false);
});

test("carries the catalog's own SKU and Salla id, not the label's text", () => {
  const [item] = readLabelContents("بكج الماتشا (1)", catalog);
  assert.equal(item.sku, catalog[1].sku);
  assert.equal(item.sallaProductId, catalog[1].sallaId);
});

test("says so when the text matches nothing rather than inventing a product", () => {
  const [item] = readLabelContents("منتج لا وجود له (2)", catalog);
  assert.equal(item.resolved, false);
  assert.equal(item.name, "منتج لا وجود له (2)");
});

test("no catalog means nothing can be claimed", () => {
  assert.deepEqual(readLabelContents("بكج الماتشا (1)", []), []);
});

/* ── a declared value is not money to collect ── */

test("reads the COD amount from under its heading, not from DV", () => {
  const [label] = parseLabelPages([
    [
      "COD/SAR",
      "J 0",
      "DV:SAR 203.97 متجر قوت",
      "Dammam 282608342",
      "Ship to: 966543773331",
      "موسى مشرقي",
      "SMSA Express",
      "MASTER#: 2917 0132 2580",
    ].join("\n"),
  ]);
  // Regression: DV is what the goods are worth. Reading it as COD tells the
  // packer to collect 203.97 for an order that is already paid for.
  assert.equal(label.codAmount, 0);
  assert.equal(label.declaredValue, 203.97);
  assert.equal(label.orderNumberOnLabel, "282608342");
  assert.equal(label.recipientName, "موسى مشرقي");
});

test("keeps a real cash-on-delivery amount", () => {
  const [label] = parseLabelPages([
    ["COD/SAR", "R 149.50", "DV:SAR 149.50", "SMSA Express"].join("\n"),
  ]);
  assert.equal(label.codAmount, 149.5);
});

test("finds a short name sharing its line with the routing letter", () => {
  const [label] = parseLabelPages([
    ["Ship to: 966536679760", "L محمد", "Saudi Arabia", "SMSA Express"].join("\n"),
  ]);
  assert.equal(label.recipientName, "محمد");
});
