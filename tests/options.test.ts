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
