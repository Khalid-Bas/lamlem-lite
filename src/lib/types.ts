/** Domain types for the lite app. Deliberately small. */

export interface PackItem {
  /** Display name — the catalog's spelling once linked. */
  name: string;
  /** Name exactly as the PDF gave it, kept so re-linking a catalog can retry. */
  rawName?: string;
  quantity: number;
  imageUrl?: string;
  /** Resolved variant text, e.g. "نوع الحليب: مشروب اوتلي". */
  optionText?: string;
  /** Variant text straight from the PDF, may contain U+FFFD markers. */
  rawOptionText?: string;
  /** True when the catalog confirmed the variant rather than the PDF alone. */
  optionVerified?: boolean;
  sku?: string;
  sallaProductId?: string;
}

export interface PackOrder {
  id: string;
  orderNumber: string;
  customerName?: string;
  city?: string;
  carrierName?: string;
  carrierId?: string;
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
  /**
   * Key the clip is stored under. Normally the order's own id, but a group
   * session points several orders at one shared recording.
   */
  videoKey?: string;
  /** Set when this order was packed as part of a multi-order session. */
  groupId?: string;
  /** Orders that share this order's video, including itself. */
  groupSize?: number;
  /** True once the packer re-scanned the label to confirm the box. */
  verified?: boolean;
}

export interface Batch {
  createdAt: string;
  orders: PackOrder[];
  records: PackRecord[];
}
