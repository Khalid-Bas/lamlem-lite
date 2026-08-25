import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOption } from "../src/lib/options.ts";
import type { Product } from "../src/lib/catalog-types.ts";

const product = (values: string[], group: string): Product => ({
  id: "p", name: "بكج", categories: [], imageUrls: [], status: "available",
  isBundle: true, hasBundleRule: false,
  variants: values.map((v, i) => ({
    id: `v${i}`, groupName: group, groupType: "image", value: v,
  })),
});

const milk = product(["مشروب اوتسايد", "مشروب اوتلي"], "نوع الحليب");
const mug = product(["مق لون اسود", "مق لون ابيض"], "لون المق");

test("repairs a variant the PDF font could not encode", () => {
  // Two ligature glyphs came back as U+FFFD: "مشروب" lost "شر", "اوتلي" lost "لي".
  const r = resolveOption("نوع الحليب م � وب اوت �", milk);
  assert.equal(r?.text, "نوع الحليب: مشروب اوتلي");
  assert.equal(r?.repaired, true);
});

test("prefers the shortest candidate when several still fit", () => {
  // Both values are subsequence-compatible with the damaged text; the marker
  // standing for the fewest hidden characters is the likelier reading.
  const r = resolveOption("م � وب اوت �", milk);
  assert.equal(r?.text, "نوع الحليب: مشروب اوتلي");
});

test("uses the catalog spelling even when nothing was damaged", () => {
  const r = resolveOption("لون المق مق لون اسود", mug);
  assert.equal(r?.text, "لون المق: مق لون اسود");
});

test("repairs a single damaged character", () => {
  const r = resolveOption("لون المق مق لون ا�يض", mug);
  assert.equal(r?.text, "لون المق: مق لون ابيض");
  assert.equal(r?.repaired, true);
});

test("does not invent a value when nothing matches", () => {
  const r = resolveOption("شيء � مختلف تمامًا", mug);
  assert.equal(r?.repaired, false, "must be flagged as unverified");
  assert.ok(!r?.text.includes("�"), "markers are not shown to the packer");
});

test("falls back to the raw text when the product has no variants", () => {
  const plain = product([], "");
  const r = resolveOption("نص حر", plain);
  assert.equal(r?.text, "نص حر");
  assert.equal(r?.repaired, false);
});

test("returns nothing for empty input", () => {
  assert.equal(resolveOption(undefined, milk), undefined);
});

/* ── multi-group products (e.g. milk type AND cup colour) ── */

const twoGroup = (): Product => ({
  id: "p2", name: "بكج الجمعات", categories: [], imageUrls: [], status: "available",
  isBundle: true, hasBundleRule: false,
  variants: [
    { id: "a1", groupName: "نوع الحليب", groupIndex: 1, groupType: "image", value: "مشروب اوتسايد" },
    { id: "a2", groupName: "نوع الحليب", groupIndex: 1, groupType: "image", value: "مشروب اوتلي" },
    { id: "b1", groupName: "لون الكوب", groupIndex: 2, groupType: "image", value: "ابيض" },
    { id: "b2", groupName: "لون الكوب", groupIndex: 2, groupType: "image", value: "اسود" },
  ],
});

test("resolves two option groups printed on separate lines", () => {
  const r = resolveOption("نوع الحليب م � وب اوت � · لون الكوب ا � ود", twoGroup());
  assert.equal(r?.text, "نوع الحليب: مشروب اوتلي · لون الكوب: اسود");
  assert.equal(r?.repaired, true);
});

test("labels each value with its own group, not the first group's name", () => {
  // Regression: every variant used to inherit group [1]'s name, so the cup
  // colour was announced as "نوع الحليب".
  const r = resolveOption("نوع الحليب مشروب اوتلي · لون الكوب ابيض", twoGroup());
  assert.ok(r?.text.includes("لون الكوب: ابيض"), `got ${r?.text}`);
  assert.ok(r?.text.includes("نوع الحليب: مشروب اوتلي"), `got ${r?.text}`);
});

test("resolves two groups even when printed on one line", () => {
  const r = resolveOption("نوع الحليب م�وب اوتلي لون الكوب ابيض", twoGroup());
  assert.equal(r?.text, "نوع الحليب: مشروب اوتلي · لون الكوب: ابيض");
  assert.equal(r?.repaired, true);
});

test("a group is never used twice across fragments", () => {
  const r = resolveOption("نوع الحليب مشروب اوتلي · نوع الحليب مشروب اوتسايد", twoGroup());
  const milkCount = (r!.text.match(/نوع الحليب:/g) ?? []).length;
  assert.equal(milkCount, 1, `each group appears once, got: ${r?.text}`);
});

/* ── clip file naming ── */
import { clipFileName } from "../src/lib/drive.ts";

test("names a single-order clip after that order", () => {
  assert.equal(clipFileName(["278290423"]), "278290423");
});

test("names a group clip after every order in it", () => {
  assert.equal(
    clipFileName(["278290423", "278307194", "278316405", "278324542"]),
    "278290423 - 278307194 - 278316405 - 278324542",
  );
});

test("trims an over-long name with a count instead of failing to save", () => {
  // 30 nine-digit numbers would be ~360 characters; most filesystems stop at 255.
  const many = Array.from({ length: 30 }, (_, i) => `2782904${String(i).padStart(2, "0")}`);
  const name = clipFileName(many);
  assert.ok(name.length <= 180, `got ${name.length} chars`);
  assert.ok(name.includes("طلب"), "says how many were left out");
  assert.ok(name.startsWith("278290400"), "keeps the first orders");
});

test("strips characters that are illegal in a filename", () => {
  assert.ok(!clipFileName(["27829/0423", "278307:194"]).includes("/"));
  assert.ok(!clipFileName(["27829/0423", "278307:194"]).includes(":"));
});

/* ── group content matching ── */
import { findContentOutliers, orderSignature } from "../src/lib/build-batch.ts";
import type { PackOrder } from "../src/lib/types.ts";

const ord = (n: string, items: { name: string; quantity: number; optionText?: string }[]): PackOrder => ({
  id: `o-${n}`, orderNumber: n, paymentType: "prepaid", items,
});

test("treats identical contents as matching regardless of line order", () => {
  const a = ord("1", [{ name: "ماتشا زعفراني 150 جرام", quantity: 1 }, { name: "استكر شيت", quantity: 2 }]);
  const b = ord("2", [{ name: "استكر شيت", quantity: 2 }, { name: "ماتشا زعفراني 150 جرام", quantity: 1 }]);
  assert.equal(orderSignature(a), orderSignature(b));
  assert.deepEqual(findContentOutliers([a, b]).outliers, []);
});

test("flags the order that differs from the rest of the pile", () => {
  const same = ["1", "2", "3"].map((n) => ord(n, [{ name: "ماتشا زعفراني 150 جرام", quantity: 1 }]));
  const odd = ord("4", [{ name: "ماتشا احتفالية فاخرة 50 جرام", quantity: 1 }]);
  const { outliers } = findContentOutliers([...same, odd]);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].orderNumber, "4");
});

test("a different quantity counts as a mismatch", () => {
  const a = ord("1", [{ name: "ماتشا", quantity: 1 }]);
  const b = ord("2", [{ name: "ماتشا", quantity: 1 }]);
  const c = ord("3", [{ name: "ماتشا", quantity: 2 }]);
  assert.deepEqual(findContentOutliers([a, b, c]).outliers.map((o) => o.orderNumber), ["3"]);
});

test("a different chosen variant counts as a mismatch", () => {
  const a = ord("1", [{ name: "بكج الجمعات", quantity: 1, optionText: "نوع الحليب: مشروب اوتلي" }]);
  const b = ord("2", [{ name: "بكج الجمعات", quantity: 1, optionText: "نوع الحليب: مشروب اوتلي" }]);
  const c = ord("3", [{ name: "بكج الجمعات", quantity: 1, optionText: "نوع الحليب: مشروب اوتسايد" }]);
  assert.deepEqual(findContentOutliers([a, b, c]).outliers.map((o) => o.orderNumber), ["3"]);
});

test("orthographic differences alone are not a mismatch", () => {
  const a = ord("1", [{ name: "بكج ماتشا وأدواتها", quantity: 1 }]);
  const b = ord("2", [{ name: "بكج ماتشا وادواتها", quantity: 1 }]);
  assert.deepEqual(findContentOutliers([a, b]).outliers, []);
});

/* ── carrier prefix in filenames ── */
import { carrierCode } from "../src/lib/carriers.ts";

test("prefixes a filename with the carrier tag", () => {
  assert.equal(clipFileName(["2562445625"], "SMSA"), "SMSA - 2562445625");
  assert.equal(
    clipFileName(["25556554", "26554852"], "DN"),
    "DN - 25556554 - 26554852",
  );
});

test("maps carrier ids to short tags", () => {
  assert.equal(carrierCode(["smsa"]), "SMSA");
  assert.equal(carrierCode(["deliver_now"]), "DN");
  assert.equal(carrierCode(["smsa", "smsa"]), "SMSA");
  // A group spanning two couriers must not claim to be one of them.
  assert.equal(carrierCode(["smsa", "deliver_now"]), "MIX");
  assert.equal(carrierCode([undefined]), "");
});

test("an unknown carrier leaves the name unprefixed", () => {
  assert.equal(clipFileName(["2562445625"], ""), "2562445625");
});

test("the carrier tag survives a trimmed long name", () => {
  const many = Array.from({ length: 30 }, (_, i) => `2782904${String(i).padStart(2, "0")}`);
  const name = clipFileName(many, "SMSA");
  assert.ok(name.startsWith("SMSA - "), `got ${name}`);
  assert.ok(name.length <= 180);
  assert.ok(name.includes("طلب"));
});

/* ── explaining a group mismatch ── */
import { explainDifference, confusableNames } from "../src/lib/build-batch.ts";

test("names the extra item that makes an order different", () => {
  const ref = ord("1", [{ name: "ماتشا زعفراني 150 جرام", quantity: 1 }]);
  const odd = ord("2", [
    { name: "ماتشا زعفراني 150 جرام", quantity: 1 },
    { name: "ملعقة ماتشا", quantity: 1 },
  ]);
  const reasons = explainDifference(odd, ref);
  assert.ok(reasons.some((r) => r.includes("صنف إضافي") && r.includes("ملعقة ماتشا")), reasons.join(" | "));
  assert.ok(reasons.some((r) => r.includes("عدد الأصناف 2 بدل 1")), reasons.join(" | "));
});

test("names a missing item and a wrong quantity", () => {
  const ref = ord("1", [
    { name: "ماتشا زعفراني 150 جرام", quantity: 1 },
    { name: "استكر شيت", quantity: 2 },
  ]);
  const odd = ord("2", [{ name: "ماتشا زعفراني 150 جرام", quantity: 3 }]);
  const reasons = explainDifference(odd, ref);
  assert.ok(reasons.some((r) => r.includes("صنف ناقص") && r.includes("استكر شيت")), reasons.join(" | "));
  assert.ok(reasons.some((r) => r.includes("الكمية 3 بدل 1")), reasons.join(" | "));
});

/* ── look-alike products ── */
test("flags the product most easily confused with a watched one", () => {
  const all = [
    "ماتشا احتفالية فاخرة 50 جرام",
    "ماتشا زعفراني 150 جرام",
    "استكر شيت من تصميم قوت",
    "كرتون قهوة أثيوبي",
  ];
  const near = confusableNames("ماتشا احتفالية فاخرة 50 جرام", all);
  assert.ok(near.includes("ماتشا زعفراني 150 جرام"), near.join(" | "));
  assert.ok(!near.includes("كرتون قهوة أثيوبي"));
});

test("an unmistakable product has no look-alikes", () => {
  const all = ["كرتون قهوة أثيوبي", "استكر شيت من تصميم قوت"];
  assert.deepEqual(confusableNames("كرتون قهوة أثيوبي", all), []);
});

test("one shared word is not enough to call two products confusable", () => {
  // Regression: "شاي ماتشا 150g" and "ملعقة ماتشا" share only "ماتشا" — a tea
  // and a spoon are not mistaken for each other.
  const all = ["شاي ماتشا 150g", "ملعقة ماتشا"];
  assert.deepEqual(confusableNames("شاي ماتشا 150g", all), []);
});

test("pairs the two coffee cartons, which differ only by origin", () => {
  const all = ["كرتون قهوة أثيوبي", "كرتون قهوة كولومبي", "استكر شيت"];
  assert.deepEqual(confusableNames("كرتون قهوة أثيوبي", all), ["كرتون قهوة كولومبي"]);
});
