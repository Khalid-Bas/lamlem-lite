import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfitReport, netOf, serviceOf } from "../src/lib/inventory/profit.ts";
import { SHIPPING_DEFAULTS } from "../src/lib/settings.ts";
import { DEFAULT_CATALOG } from "../src/lib/catalog-default.ts";
import type { Product } from "../src/lib/catalog-types.ts";
import type { PackOrder } from "../src/lib/types.ts";

/**
 * What a day of orders earned.
 *
 * The figures here are the merchant's own tariffs, so a change to the defaults
 * that quietly alters the profit shows up as a failing number rather than as a
 * plausible-looking sheet.
 */

const prefs = { vatPercent: 15, shipping: SHIPPING_DEFAULTS };

const near = (actual: number, expected: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    `${what}: got ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`,
  );

const product = (name: string, sku: string, cost?: number): Product => ({
  id: sku,
  sku,
  name,
  categories: [],
  imageUrls: [],
  cost,
  status: "available",
  variants: [],
  isBundle: false,
  hasBundleRule: false,
});

const order = (o: Partial<PackOrder> & { total?: number }): PackOrder => ({
  id: o.id ?? "o1",
  orderNumber: o.orderNumber ?? "1001",
  paymentType: "prepaid",
  totalAmount: o.total,
  items: o.items ?? [],
  ...o,
});

/* ── VAT is not income ── */

test("takes VAT out before anything is called revenue", () => {
  // 115 paid at 15% is 100 earned and 15 owed to ZATCA.
  near(netOf(115, 15), 100, "net of 115");
  const r = buildProfitReport([order({ total: 115, service: "dn" })], [], prefs);
  near(r.totals.netSales, 100, "net sales");
  near(r.totals.vat, 15, "vat");
});

/* ── each carrier's own tariff ── */

test("Deliver Now costs 14 net, as agreed without VAT", () => {
  const r = buildProfitReport([order({ total: 115, service: "dn" })], [], prefs);
  near(r.orders[0].shippingCost, 14, "dn shipping cost");
  // 100 earned − 14 shipping − 0 goods.
  near(r.orders[0].netProfit, 86, "dn net profit");
});

test("SMSA home delivery costs 29 including VAT, so 25.22 net", () => {
  const r = buildProfitReport([order({ total: 115, service: "smsaHome" })], [], prefs);
  near(r.orders[0].shippingCost, 29 / 1.15, "smsa home shipping cost");
  near(r.orders[0].netProfit, 100 - 29 / 1.15, "smsa home net profit");
});

test("SMSA branch pickup costs 14 net, like Deliver Now", () => {
  const r = buildProfitReport([order({ total: 115, service: "smsaPickup" })], [], prefs);
  near(r.orders[0].shippingCost, 14, "smsa pickup shipping cost");
});

test("a changed tariff moves the profit, without touching the code", () => {
  const dearer = {
    vatPercent: 15,
    shipping: {
      ...SHIPPING_DEFAULTS,
      dn: { ...SHIPPING_DEFAULTS.dn, cost: 20 },
    },
  };
  const r = buildProfitReport([order({ total: 115, service: "dn" })], [], dearer);
  near(r.orders[0].netProfit, 80, "net profit at the new rate");
});

/* ── which tariff applies ── */

test("the label's service wins; without one SMSA is assumed to be home", () => {
  assert.deepEqual(serviceOf(order({ service: "smsaPickup", carrierId: "smsa" })), {
    service: "smsaPickup",
    assumed: false,
  });
  assert.deepEqual(serviceOf(order({ carrierId: "deliver_now" })), {
    service: "dn",
    assumed: false,
  });
  // Assumed, and the dearer of the two, so the profit is never flattered.
  assert.deepEqual(serviceOf(order({ carrierId: "smsa" })), {
    service: "smsaHome",
    assumed: true,
  });
});

test("says how many orders had to guess at the shipping service", () => {
  const r = buildProfitReport(
    [order({ total: 115, carrierId: "smsa" }), order({ total: 115, service: "dn" })],
    [],
    prefs,
  );
  assert.equal(r.unknownService, 1);
  assert.match(r.orders[0].note ?? "", /نوع الشحن غير مذكور/);
  assert.equal(r.orders[1].note, undefined);
});

/* ── cost of goods ── */

test("charges the cost of every unit in the box", () => {
  const catalog = [product("شاي ماتشا 150g", "6971291060131", 35.56)];
  const r = buildProfitReport(
    [
      order({
        total: 115,
        service: "dn",
        items: [{ name: "شاي ماتشا 150g", sku: "6971291060131", quantity: 3 }],
      }),
    ],
    catalog,
    prefs,
  );
  near(r.orders[0].productCost, 106.68, "3 units at 35.56");
  near(r.orders[0].netProfit, 100 - 14 - 106.68, "net profit");
  near(r.orders[0].margin, (100 - 14 - 106.68) / 100, "margin");
});

test("names an uncosted product rather than treating it as free", () => {
  const catalog = [product("بكج اليوم الوطني", "Watan96")];
  const r = buildProfitReport(
    [
      order({
        total: 115,
        service: "dn",
        items: [{ name: "بكج اليوم الوطني", sku: "Watan96", quantity: 1 }],
      }),
    ],
    catalog,
    prefs,
  );
  assert.deepEqual(r.uncosted, ["بكج اليوم الوطني"]);
  assert.match(r.orders[0].note ?? "", /لا توجد تكلفة/);
  // Still reported, but the reader is told the figure is too high.
  near(r.orders[0].productCost, 0, "no cost counted");
});

test("an order with no total at all is flagged, not silently zeroed", () => {
  const r = buildProfitReport([order({ service: "dn" })], [], prefs);
  assert.equal(r.untotalled, 1);
  assert.match(r.orders[0].note ?? "", /لا يوجد مبلغ/);
});

/* ── the real numbers ── */

test("a real matcha order through SMSA home delivery", () => {
  // #285625843 from 14 Sep: 89.98 paid, one شاي ماتشا 150g costing 35.56.
  const r = buildProfitReport(
    [
      order({
        total: 89.98,
        service: "smsaHome",
        items: [{ name: "شاي ماتشا 150g", sku: "6971291060131", quantity: 1 }],
      }),
    ],
    DEFAULT_CATALOG,
    prefs,
  );
  const o = r.orders[0];
  near(o.netSales, 78.24, "net sales");
  near(o.vat, 11.74, "vat");
  near(o.shippingCost, 25.22, "shipping cost");
  near(o.productCost, 35.56, "product cost");
  near(o.netProfit, 78.24 - 25.22 - 35.56, "net profit");
  near(o.margin, (78.24 - 25.22 - 35.56) / 78.24, "margin");
});

test("totals add up across a mixed batch", () => {
  const orders = [
    order({ id: "a", total: 89.98, service: "smsaHome" }),
    order({ id: "b", total: 82.97, service: "dn" }),
    order({ id: "c", total: 96, service: "smsaPickup" }),
  ];
  const r = buildProfitReport(orders, [], prefs);
  near(r.totals.total, 268.95, "gross total");
  near(r.totals.netSales, 268.95 / 1.15, "net sales");
  near(r.totals.vat, 268.95 - 268.95 / 1.15, "vat");
  near(r.totals.shippingCost, 29 / 1.15 + 14 + 14, "shipping cost");
  near(r.totals.netProfit, r.totals.netSales - r.totals.totalCost, "net profit");
  assert.equal(
    r.orders.length,
    3,
    "every order keeps its own row, however the totals come out",
  );
});
