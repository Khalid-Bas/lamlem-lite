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
