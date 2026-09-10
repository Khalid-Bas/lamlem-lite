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

/**
 * One packed order: its photo and when it was taken.
 *
 * A photo always belongs to exactly one order — that is the point of the mode
 * — so even a group session leaves one record and one file per box.
 */
export interface PackRecord {
  orderId: string;
  packedAt: string;
  hasPhoto: boolean;
  photoBytes?: number;
  /**
   * True once the label on the sealed box was scanned. In the photo flow that
   * scan is what opens the shutter screen, so it is always true here.
   */
  verified?: boolean;
}

export interface Batch {
  createdAt: string;
  orders: PackOrder[];
  records: PackRecord[];
}
