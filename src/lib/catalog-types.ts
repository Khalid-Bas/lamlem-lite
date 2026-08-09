/** Catalog shapes produced by the Salla product-export importer. */

export type ProductStatus = "available" | "unavailable" | "hidden";

export interface Variant {
  id: string;
  groupName: string;
  groupType: "image" | "text";
  value: string;
  imageUrl?: string;
  sku?: string;
  price?: number;
  stock?: number;
}

export interface Product {
  id: string;
  /** Salla's own product id from the export's "No." column. */
  sallaId?: string;
  name: string;
  sku?: string;
  categories: string[];
  imageUrls: string[];
  descriptionHtml?: string;
  price?: number;
  stock?: number;
  weight?: number;
  weightUnit?: string;
  barcode?: string;
  gtin?: string;
  status: ProductStatus;
  variants: Variant[];
  isBundle: boolean;
  hasBundleRule: boolean;
  shelfCode?: string;
}
