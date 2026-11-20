/** Bảng giá public price.hisweetievietnam.com — kiểu cấu hình (lưu JSON) và dữ liệu trang public. */

export type PriceRegionKey = 'N' | 'S';
/** Mã nhóm sản phẩm: 4 nhóm mặc định (tea/jam/top/froz) hoặc mã sinh khi thêm nhóm mới. */
export type PriceGroupKey = string;
/** Kiểu hiển thị (màu + biểu tượng) của nhóm trên trang public. */
export type PriceGroupIcon = 'tea' | 'jam' | 'top' | 'froz' | 'pow';
export type PriceTag = 'new' | 'hot' | 'sale';

/** 5 nhóm mặc định, đúng thứ tự (cấu hình chưa có danh sách nhóm). Mã nhóm trùng kiểu hiển thị. */
export const PRICE_GROUPS: { key: PriceGroupIcon; name: string }[] = [
  { key: 'tea', name: 'Trà' },
  { key: 'jam', name: 'Mứt & Syrup' },
  { key: 'top', name: 'Topping nhiệt thường' },
  { key: 'froz', name: 'Topping đông lạnh' },
  { key: 'pow', name: 'Bột' },
];
export const PRICE_GROUP_ICONS: PriceGroupIcon[] = [
  'tea',
  'jam',
  'top',
  'froz',
  'pow',
];
export const PRICE_GROUP_MAX = 8;
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

export interface PriceGroupConfig {
  key: PriceGroupKey;
  name: string;
  icon: PriceGroupIcon;
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
  /** Ảnh hiện trên trang public (id ảnh của sản phẩm); null hoặc ảnh đã xoá = ảnh chính */
  imageId: number | null;
  /** Thương hiệu hiển thị (tradeMarkId trong `brands`); null = thương hiệu của sản phẩm */
  brandId: number | null;
  /** Ghi đè khối lượng / quy cách / đơn vị tính; rỗng = tự tách từ tên POS */
  size: string;
  spec: string;
  unit: string;
}

/** Khối lượng / quy cách / đơn vị tính của một sản phẩm */
export interface PriceSpecInfo {
  size: string;
  spec: string;
  unit: string;
}

export interface PricePageConfig {
  regions: PriceRegionConfig[];
  zaloUrl: string;
  banner: { enabled: boolean; tag: string; text: string };
  /** yyyy-mm-dd, rỗng = không ghi */
  validFrom: string;
  validTo: string;
  /** Thứ tự mảng = thứ tự tab nhóm trên trang public */
  groups: PriceGroupConfig[];
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
  groups: { key: PriceGroupKey; name: string; icon: PriceGroupIcon }[];
  brands: { id: number; name: string }[];
  products: PublicPriceProduct[];
}

/** Thông tin sản phẩm cho bảng cấu hình (mọi sản phẩm trong cấu hình, kể cả đang ẩn). */
export interface PriceCatalogEntry {
  id: number;
  code: string;
  fullName: string;
  /** Ảnh đang chọn cho trang public */
  image: string | null;
  isActive: boolean;
  tradeMarkId: number | null;
  tradeMarkName: string | null;
  price: Record<PriceRegionKey, number | null>;
  /** Mọi ảnh của sản phẩm, ảnh chính đứng đầu */
  images: { id: number; image: string }[];
  /** Giá trị tự động (tách từ tên POS) khi không ghi đè */
  auto: PriceSpecInfo & { name: string };
}
