import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderPages } from "../src/lib/pdf/orders.ts";

/**
 * Line-level regression tests for the Salla invoice product table.
 *
 * Built from real reconstructed pages but with customer data removed, so they
 * are safe to publish and stay deterministic.
 */
const page = (rows: string[]) =>
  [
    "PAID",
    "رقم الطلب",
    "#276219057",
    "متجر قوت",
    "السعودية",
    "جدة",
    "شارع ما، الرمز البريدي 22444",
    "+966500000000",
    "المبلغ 157.98SAR",
    "طريقة الدفع مدى",
    "رقم الشحنة DNL03424480893",
    "المنتج رقم المنتج التصنيف الرقم المخزني الكمية",
    ...rows,
    "شكرًا لشرائك من المتجر",
  ].join("\n");

test("reads a line item whose Salla product id is 8 digits", () => {
  // Regression: an exact \d{9} match silently dropped every such line, which
  // was 20 of 30 orders in a real batch.
  const [order] = parseOrderPages([
    page(["شاي ماتشا 150g 88224991 جميع المنتجات 6971291060131 1"]),
  ]);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].name, "شاي ماتشا 150g");
  assert.equal(order.items[0].sallaProductId, "88224991");
  assert.equal(order.items[0].sku, "6971291060131");
  assert.equal(order.items[0].quantity, 1);
});

test("reads 9-digit ids and short internal stock codes too", () => {
  const [order] = parseOrderPages([
    page([
      "بكج ماتشا احتفالية فاخرة 50 جرام وادواتها 115282434 جميع المنتجات 02314 1",
      "اسود",
    ]),
  ]);
  assert.equal(order.items.length, 1);
  // The name wraps onto the following line and must be re-joined.
  assert.equal(
    order.items[0].name,
    "بكج ماتشا احتفالية فاخرة 50 جرام وادواتها اسود",
  );
  assert.equal(order.items[0].sku, "02314");
});

test("keeps multiple line items separate", () => {
  const [order] = parseOrderPages([
    page([
      "شاي ماتشا 150g 88224991 جميع المنتجات 6971291060131 1",
      "ملعقة ماتشا 108833168 جميع المنتجات 00060 2",
    ]),
  ]);
  assert.equal(order.items.length, 2);
  assert.deepEqual(
    order.items.map((i) => [i.name, i.quantity]),
    [["شاي ماتشا 150g", 1], ["ملعقة ماتشا", 2]],
  );
});

test("captures the chosen variant instead of gluing it to the name", () => {
  const [order] = parseOrderPages([
    page([
      "بكج ال 99 108978784 جميع المنتجات 00034 1",
      "خيارات المنتج",
      "نوع الحليب مشروب اوتلي",
    ]),
  ]);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].name, "بكج ال 99", "option text must not pollute the name");
  assert.equal(order.items[0].optionText, "نوع الحليب مشروب اوتلي");
});

test("still reads the order's own fields", () => {
  const [order] = parseOrderPages([
    page(["شاي ماتشا 150g 88224991 جميع المنتجات 6971291060131 1"]),
  ]);
  assert.equal(order.orderNumber, "276219057");
  assert.equal(order.trackingRaw, "DNL03424480893");
  assert.equal(order.carrierId, "deliver_now");
  assert.equal(order.city, "جدة");
  assert.equal(order.totalAmount, 157.98);
});
