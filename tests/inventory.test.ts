import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBom, type Bom } from "../src/lib/inventory/bom.ts";
import { matchBomRow, tally, tallySold } from "../src/lib/inventory/tally.ts";
import { DEFAULT_BOM } from "../src/lib/inventory/bom-default.ts";
import type { PackItem, PackOrder } from "../src/lib/types.ts";

/**
 * Stocktake: what was sold, and what that costs the shelves.
 *
 * The numbers here are checked against the merchant's own matrix, so a change
 * that quietly stops exploding bundles shows up as a wrong component count
 * rather than as a plausible-looking sheet.
 */

const ord = (id: string, items: Partial<PackItem>[]): PackOrder => ({
  id,
  orderNumber: id,
  paymentType: "prepaid",
  items: items.map((i) => ({ name: "x", quantity: 1, ...i })),
});

/* ── reading the matrix ── */

test("sums columns that repeat the same component", () => {
  // The real sheet lists «استكر شيت من تصميم قوت (قهوة)» in two columns; one
  // must not shadow the other.
  const bom = parseBom([
    ["#", "المنتج", "SKU", "كرتون", "استكر", "استكر"],
    [1, "بكج", "A1", 1, 2, 3],
  ]);
  assert.equal(bom.rows.length, 1);
  assert.deepEqual(bom.rows[0].components, [
    { name: "كرتون", qty: 1 },
    { name: "استكر", qty: 5 },
  ]);
  assert.deepEqual(bom.components, ["كرتون", "استكر"]);
});

test("ignores blank cells, zeros and rows with no product", () => {
  const bom = parseBom([
    ["#", "المنتج", "SKU", "كرتون", "كوب"],
    [1, "بكج", "A1", "", 0],
    [2, "", "A2", 1, 1],
  ]);
  assert.equal(bom.rows.length, 1);
  assert.deepEqual(bom.rows[0].components, []);
});

/* ── grouping what was sold ── */

test("groups identical lines across orders and counts the orders", () => {
  const sold = tallySold([
    ord("1", [{ name: "شاي ماتشا 150g", quantity: 1 }]),
    ord("2", [{ name: "شاي ماتشا 150g", quantity: 2 }]),
    ord("3", [{ name: "ملعقة ماتشا", quantity: 1 }]),
  ]);
  assert.deepEqual(
    sold.map((s) => [s.name, s.quantity, s.orders]),
    [
      ["شاي ماتشا 150g", 3, 2],
      ["ملعقة ماتشا", 1, 1],
    ],
  );
});

test("keeps two variants of one product apart", () => {
  const sold = tallySold([
    ord("1", [{ name: "بكج ال 99", optionText: "نوع الحليب: مشروب اوتلي" }]),
    ord("2", [{ name: "بكج ال 99", optionText: "نوع الحليب: مشروب اوتسايد" }]),
    ord("3", [{ name: "بكج ال 99", optionText: "نوع الحليب: مشروب اوتلي" }]),
  ]);
  assert.equal(sold.length, 2);
  assert.equal(sold[0].quantity, 2);
  assert.equal(sold[0].option, "نوع الحليب: مشروب اوتلي");
});

/* ── finding the right row ── */

test("the SKU decides between rows that share a name", () => {
  // «استكر شيت من تصميم قوت» is three different printings in the real sheet.
  const { row } = matchBomRow(
    { name: "استكر شيت من تصميم قوت", sku: "0007" },
    DEFAULT_BOM,
  );
  assert.deepEqual(row?.components, [{ name: "استكر شيت من تصميم قوت (قديم)", qty: 1 }]);
});

test("a leading zero in the order does not lose the row", () => {
  // The sheet writes 2467, the catalog 02467 — the same SKU either way.
  const { row } = matchBomRow({ name: "25 كوب ورقي تصميم قوت", sku: "02467" }, DEFAULT_BOM);
  assert.equal(row?.sku, "2467");
});

test("the chosen option picks the variant row", () => {
  const outside = matchBomRow(
    { name: "بكج ال 99", option: "نوع الحليب: مشروب اوتسايد" },
    DEFAULT_BOM,
  ).row;
  const oatly = matchBomRow(
    { name: "بكج ال 99", option: "نوع الحليب: مشروب اوتلي" },
    DEFAULT_BOM,
  ).row;
  assert.ok(outside?.components.some((c) => c.name.startsWith("اوتسايد")));
  assert.ok(oatly?.components.some((c) => c.name.startsWith("اوتلي")));
});

test("a variant the order cannot state is not treated as ambiguous", () => {
  // The sheet splits «بكج الجمعات» by carton colour as well as milk, but the
  // catalog only ever asks for the milk. Both colours consume the same things,
  // so there is nothing to warn about.
  const { row, note } = matchBomRow(
    { name: "بكج الجمعات", option: "نوع الحليب: مشروب اوتلي" },
    DEFAULT_BOM,
  );
  assert.equal(note, undefined);
  assert.ok(row?.components.some((c) => c.name.startsWith("اوتلي")));
});

test("a product name containing a dash is not read as a variant", () => {
  const { row } = matchBomRow({ name: "بكج القهوة - أثيوبي وكولومبي" }, DEFAULT_BOM);
  assert.equal(row?.sku, "CoffeePackage");
});

test("flags a tie between rows that consume different things", () => {
  const bom: Bom = {
    components: ["أ", "ب"],
    rows: [
      { name: "بكج - أحمر", components: [{ name: "أ", qty: 1 }] },
      { name: "بكج - أزرق", components: [{ name: "ب", qty: 1 }] },
    ],
  };
  const { row, note } = matchBomRow({ name: "بكج" }, bom);
  assert.ok(row);
  assert.match(note ?? "", /أكثر من صف/);
});

/* ── the whole stocktake ── */

test("a bundle is charged to its components, multiplied by quantity", () => {
  const t = tally(
    [
      ord("1", [{ name: "شاي ماتشا 150g", sku: "6971291060131", quantity: 23 }]),
      ord("2", [{ name: "بكج الماتشا", sku: "00055", quantity: 3 }]),
    ],
    DEFAULT_BOM,
  );
  const qty = (n: string) => t.components.find((c) => c.name === n)?.quantity;
  // Both recipes use one small carton, two new-design cups, one sticker sheet,
  // one card and one tin — so 26 of each, and 52 cups.
  assert.equal(qty("كرتون تغليف صغير"), 26);
  assert.equal(qty("كوب ورقي تصميم قوت (تصميم جديد)"), 52);
  assert.equal(qty("استكر شيت من تصميم قوت (جديد)"), 26);
  assert.equal(qty("كرت مق مجاني"), 26);
  assert.equal(qty("شاي ماتشا 150g"), 26);
  assert.deepEqual(t.unresolved, []);
});

test("components come out in the sheet's own column order", () => {
  const t = tally(
    [ord("1", [{ name: "بكج ماتشا احتفالية فاخرة 50 جرام وادواتها اسود", sku: "02314" }])],
    DEFAULT_BOM,
  );
  const order = t.components.map((c) => DEFAULT_BOM.components.indexOf(c.name));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});

test("says which lines it could not cost instead of dropping them", () => {
  const t = tally(
    [
      ord("1", [{ name: "منتج لا وجود له", quantity: 2 }]),
      // Present in the sheet, but with an empty component row.
      ord("2", [{ name: "حافظه بتفريغ الهواء 900ملي", sku: "011" }]),
      ord("3", [{ name: "شاي ماتشا 150g", sku: "6971291060131" }]),
    ],
    DEFAULT_BOM,
  );
  assert.deepEqual(
    t.unresolved.map((s) => s.name).sort(),
    ["حافظه بتفريغ الهواء 900ملي", "منتج لا وجود له"],
  );
  assert.match(t.sold.find((s) => s.name === "منتج لا وجود له")?.note ?? "", /غير موجود/);
  // The line that did resolve is still fully counted.
  assert.equal(t.components.find((c) => c.name === "شاي ماتشا 150g")?.quantity, 1);
});
