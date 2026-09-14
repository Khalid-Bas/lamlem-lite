import { findProduct } from "../build-batch.ts";
import type { Product } from "../catalog-types.ts";
import type { PackOrder } from "../types.ts";
import type { Settings, ShipService, ShipTariff } from "../settings.ts";

/**
 * What a day of orders actually earned.
 *
 * Three figures have to be kept apart or the answer is wrong:
 *
 *   • **VAT is not income.** It is collected on the store's behalf and handed
 *     to ZATCA, so it comes out of the total before anything is called revenue.
 *   • **Shipping is charged and also paid for.** The customer's shipping is
 *     already inside the order total; what the carrier bills us is a real cost
 *     and is subtracted, net of its own VAT, which is reclaimable.
 *   • **Cost of goods is per unit sold**, from the product list.
 *
 * Everything is computed on net-of-VAT figures, which is the only basis on
 * which revenue and cost are comparable.
 */

export interface OrderProfit {
  orderNumber: string;
  customerName?: string;
  carrier: string;
  service?: ShipService;
  serviceLabel: string;
  /** What the customer paid, VAT and shipping included. */
  total: number;
  /** That total with VAT taken out — the revenue actually earned. */
  netSales: number;
  vat: number;
  /** The carrier's bill for this parcel, excluding VAT. */
  shippingCost: number;
  /** Cost of the goods in the box, excluding VAT. */
  productCost: number;
  totalCost: number;
  netProfit: number;
  /** Net profit as a share of net sales. */
  margin: number;
  /** Set when something had to be assumed rather than read. */
  note?: string;
}

export interface ProfitReport {
  orders: OrderProfit[];
  totals: {
    total: number;
    netSales: number;
    vat: number;
    shippingCost: number;
    productCost: number;
    totalCost: number;
    netProfit: number;
    margin: number;
  };
  /** Products sold in this batch that carry no cost price yet. */
  uncosted: string[];
  /** Orders whose shipping service the label did not state. */
  unknownService: number;
  /** Orders with no total on them, which cannot be valued at all. */
  untotalled: number;
}

const NO_COST = "لا توجد تكلفة لبعض المنتجات";
const NO_TOTAL = "لا يوجد مبلغ للطلب";
const ASSUMED_SERVICE = "نوع الشحن غير مذكور — استُخدم الافتراضي";

/** Strips VAT from a gross figure. */
export function netOf(amount: number, vatPercent: number): number {
  return amount / (1 + vatPercent / 100);
}

function tariffCostNet(t: ShipTariff, vatPercent: number): number {
  return t.costIncludesVat ? netOf(t.cost, vatPercent) : t.cost;
}

/**
 * Which tariff applies to an order.
 *
 * The label names the service outright for SMSA. Without one — an order read
 * from the invoice alone, where the service is not printed — the carrier
 * decides, and SMSA falls back to home delivery because that is the dearer of
 * the two and understating a cost flatters the profit.
 */
export function serviceOf(order: PackOrder): { service: ShipService; assumed: boolean } {
  if (order.service) return { service: order.service, assumed: false };
  if (order.carrierId === "deliver_now") return { service: "dn", assumed: false };
  return { service: "smsaHome", assumed: true };
}

export function buildProfitReport(
  orders: PackOrder[],
  products: Product[],
  prefs: Pick<Settings, "vatPercent" | "shipping">,
): ProfitReport {
  const vatPercent = prefs.vatPercent;
  const uncosted = new Set<string>();
  let unknownService = 0;
  let untotalled = 0;

  const rows = orders.map((order): OrderProfit => {
    const { service, assumed } = serviceOf(order);
    if (assumed) unknownService++;
    const tariff = prefs.shipping[service];

    const total = order.totalAmount ?? 0;
    if (!order.totalAmount) untotalled++;
    const netSales = netOf(total, vatPercent);
    const vat = total - netSales;

    let productCost = 0;
    let missingCost = false;
    for (const item of order.items) {
      const product = findProduct(
        { sallaProductId: item.sallaProductId, sku: item.sku, name: item.name },
        products,
      );
      if (product?.cost === undefined) {
        missingCost = true;
        uncosted.add(product?.name ?? item.name);
        continue;
      }
      productCost += product.cost * item.quantity;
    }

    const shippingCost = tariffCostNet(tariff, vatPercent);
    const totalCost = shippingCost + productCost;
    const netProfit = netSales - totalCost;

    const notes = [
      !order.totalAmount ? NO_TOTAL : "",
      missingCost ? NO_COST : "",
      assumed ? ASSUMED_SERVICE : "",
    ].filter(Boolean);

    return {
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      carrier: order.carrierName ?? order.carrierId ?? "—",
      service,
      serviceLabel: tariff.label,
      total,
      netSales,
      vat,
      shippingCost,
      productCost,
      totalCost,
      netProfit,
      margin: netSales > 0 ? netProfit / netSales : 0,
      note: notes.join(" · ") || undefined,
    };
  });

  const sum = (pick: (r: OrderProfit) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const netSales = sum((r) => r.netSales);
  const netProfit = sum((r) => r.netProfit);

  return {
    orders: rows,
    totals: {
      total: sum((r) => r.total),
      netSales,
      vat: sum((r) => r.vat),
      shippingCost: sum((r) => r.shippingCost),
      productCost: sum((r) => r.productCost),
      totalCost: sum((r) => r.totalCost),
      netProfit,
      margin: netSales > 0 ? netProfit / netSales : 0,
    },
    uncosted: [...uncosted],
    unknownService,
    untotalled,
  };
}
