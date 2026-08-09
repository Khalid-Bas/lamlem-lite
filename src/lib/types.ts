/** Domain types for the lite app. Deliberately small. */

export interface PackItem {
  name: string;
  quantity: number;
  imageUrl?: string;
  optionText?: string;
  sku?: string;
}

export interface PackOrder {
  id: string;
  orderNumber: string;
  customerName?: string;
  city?: string;
  carrierName?: string;
  trackingRaw?: string;
  paymentType: "cod" | "prepaid";
  totalAmount?: number;
  items: PackItem[];
}

export interface PackRecord {
  orderId: string;
  /** Milliseconds from scan-in to scan-out. */
  durationMs: number;
  packedAt: string;
  hasVideo: boolean;
  videoBytes?: number;
}

export interface Batch {
  createdAt: string;
  orders: PackOrder[];
  records: PackRecord[];
}
