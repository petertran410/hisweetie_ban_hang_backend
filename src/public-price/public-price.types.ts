/** Bảng giá public price.hisweetievietnam.com — kiểu cấu hình (lưu JSON) và dữ liệu trang public. */

export type PriceRegionKey = 'N' | 'S';
export type PriceGroupKey = 'tea' | 'jam' | 'top' | 'froz';
export type PriceTag = 'new' | 'hot' | 'sale';

/** 4 nhóm sản phẩm cố định, đúng thứ tự hiển thị. */
export const PRICE_GROUPS: { key: PriceGroupKey; name: string }[] = [
  { key: 'tea', name: 'Trà' },
  { key: 'jam', name: 'Mứt & Syrup' },
  { key: 'top', name: 'Topping nhiệt thường' },
  { key: 'froz', name: 'Topping đông lạnh' },
];
export const PRICE_REGION_KEYS: PriceRegionKey[] = ['N', 'S'];
export const PRICE_TAGS: PriceTag[] = ['new', 'hot', 'sale'];

export interface PriceRegionConfig {
  key: PriceRegionKey;
  /** "Miền Bắc" / "Miền Nam" */
  name: string;
  /** Tên bảng giá hiện cho khách, vd "Bảng giá chung" */
  listName: string;
  /** null = giá bán gốc của sản phẩm (Bảng giá chung) */
  priceBookId: number | null;
  hotline: string;
  enabled: boolean;
}

export interface PriceBrandConfig {
  tradeMarkId: number;
  /** Tên hiển thị, vd "Trà Phượng Hoàng" */
  label: string;
  visible: boolean;
}

export interface PriceItemConfig {
  productId: number;
  group: PriceGroupKey;
  visible: boolean;
  tag: PriceTag | null;
  /** Khu vực ẩn giá → hiện "Liên hệ" */
  hidePrice: PriceRegionKey[];
  /** Tên hiển thị riêng; rỗng = tách từ tên POS */
  name: string;
  /** Mô tả ngắn trong bottom sheet */
  desc: string;
}

export interface PricePageConfig {
  regions: PriceRegionConfig[];
  zaloUrl: string;
  banner: { enabled: boolean; tag: string; text: string };
  /** yyyy-mm-dd, rỗng = không ghi */
  validFrom: string;
  validTo: string;
  hiddenGroups: PriceGroupKey[];
  /** Thứ tự mảng = thứ tự badge thương hiệu */
  brands: PriceBrandConfig[];
  /** Thứ tự mảng = thứ tự trong từng nhóm */
  items: PriceItemConfig[];
}

export interface PublicPriceProduct {
  id: number;
  code: string;
  name: string;
  /** Khối lượng/dung tích tách từ tên, vd "500gr" */
  size: string;
  /** Quy cách, vd "20 Gói/Thùng" */
  spec: string;
  unit: string;
  brandId: number | null;
  group: PriceGroupKey;
  image: string | null;
  tag: PriceTag | null;
  desc: string;
  /** null = "Liên hệ" */
  price: Record<PriceRegionKey, number | null>;
}

export interface PublicPriceData {
  publishedAt: string | null;
  validFrom: string;
  validTo: string;
  zaloUrl: string;
  banner: { enabled: boolean; tag: string; text: string };
  regions: {
    key: PriceRegionKey;
    name: string;
    listName: string;
    hotline: string;
  }[];
  groups: { key: PriceGroupKey; name: string }[];
  brands: { id: number; name: string }[];
  products: PublicPriceProduct[];
}

/** Thông tin sản phẩm cho bảng cấu hình (mọi sản phẩm trong cấu hình, kể cả đang ẩn). */
export interface PriceCatalogEntry {
  id: number;
  code: string;
  fullName: string;
  image: string | null;
  isActive: boolean;
  tradeMarkId: number | null;
  tradeMarkName: string | null;
  price: Record<PriceRegionKey, number | null>;
}
