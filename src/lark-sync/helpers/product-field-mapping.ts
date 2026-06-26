/**
 * Mapping cấu hình cho việc sync Sản Phẩm lên Lark Base.
 * Base: Vx4hb0o0Va3S1RsvbpGl4imYgYc — Table: tbldKbrNjFkqdzao (Sản Phẩm).
 *
 * Bảng Sản Phẩm trên Lark là flat/denormalized: gộp sẵn tồn kho 3 kho,
 * giá vốn 3 kho và các bảng giá vào cùng 1 record.
 */

// Các field text/định danh trên Lark
export const LARK_PRODUCT_FIELDS = {
  MA_HANG_HOA: 'Mã Hàng Hoá',
  ID_HANG_HOA: 'Id Hàng Hoá',
  TEN_HANG_HOA: 'Tên Hàng Hoá',
  TEN_DAY_DU: 'Tên Đầy Đủ',
  THUONG_HIEU: 'Thương Hiệu',
  DON_VI: 'Đơn Vị',
  CAN_NANG: 'Cân Nặng',
  MO_TA: 'Mô Tả',
  NGUON_GOC: 'Nguồn Gốc',
  LOAI_HANG: 'Loại Hàng',
  DANH_MUC: 'Danh Mục',
  CHO_PHEP_BAN: 'Cho Phép Bán',
  HANG_KINH_DOANH: 'Hàng Kinh Doanh',
  NGAY_TAO: 'Ngày Tạo',
  NGAY_CAP_NHAT: 'Ngày Cập Nhật',
  BANG_GIA_CHUNG: 'Bảng Giá Chung',
} as const;

/**
 * Map branchId (DB) → cặp cột Tồn Kho / Giá Vốn trên Lark.
 * Chỉ sync 3 kho theo yêu cầu: 6 = Kho Hà Nội, 1 = Kho Sài Gòn, 5 = Văn Phòng Hà Nội.
 */
export const BRANCH_INVENTORY_COLUMNS: Record<
  number,
  { onHand: string; cost: string }
> = {
  6: {
    onHand: 'Tồn Kho (Kho Hà Nội)',
    cost: 'Giá Vốn (Kho Hà Nội)',
  },
  1: {
    onHand: 'Tồn Kho (Kho Sài Gòn)',
    cost: 'Giá Vốn (Kho Sài Gòn)',
  },
  5: {
    onHand: 'Tồn Kho (Văn Phòng Hà Nội)',
    cost: 'Giá Vốn (Văn Phòng Hà Nội)',
  },
};

export const SYNCED_BRANCH_IDS = Object.keys(BRANCH_INVENTORY_COLUMNS).map(
  (id) => Number(id),
);

/**
 * Map priceBook → tên cột bảng giá trên Lark, ĐỐI CHIẾU THEO TÊN (không theo id).
 *
 * Lý do: priceBookId trong DB KHÔNG ổn định (bị inactive/đổi tên → id tái sử
 * dụng cho bảng giá khác). Map theo id từng gây đẩy sai cột. Đối chiếu theo
 * tên đã chuẩn hoá (uppercase + gộp khoảng trắng) bền vững hơn.
 *
 * Cách build: normalize(tên DB) → tên cột Lark CHÍNH XÁC.
 * Phần lớn tên DB khi normalize trùng luôn tên cột Lark (cũng normalize), nên
 * dưới đây chỉ cần liệt kê các cột Lark; lookup sẽ tự so theo bản normalize.
 */

/** Danh sách CHÍNH XÁC tên cột bảng giá trên Lark (để đẩy lên đúng key). */
const LARK_PRICE_BOOK_COLUMNS: string[] = [
  'Bảng Giá Buôn HCM',
  'Bảng Giá Buôn HN',
  'Bảng Giá Cheese Coffee',
  'Bảng Giá Chiến Lược',
  'Bảng Giá Chuỗi Đảo Matcha',
  'Bảng giá chuỗi Đô Đô',
  'Bảng Giá Chuỗi Laboong',
  'Bảng Giá Chuỗi ShanCha',
  'Bảng Giá CHUỖI SHUYI',
  'Bảng giá chuỗi Sunday Basic',
  'Bảng Giá Cing Hu Tang',
  'Bảng Giá Đỗ Minh Tân',
  'Bảng Giá Đỗ Minh Tân 8%',
  'Bảng Giá Em Hoài RoyalTea',
  'Bảng Giá Hadilao Việt Nam',
  'Bảng Giá Hoàng Quân HCM',
  'Bảng Giá Học Viện Cafe Hà Nội',
  'Bảng Giá Kido',
  'Bảng Giá Lasimi Sài Gòn',
  'Bảng Giá Lẻ HCM',
  'Bảng Giá Shopee',
  'Chuỗi Lá Trà Non',
  'Bảng Giá Cộng Tác Viên',
  'Bảng Giá Kaffa',
  'Bảng Giá Học Viện Cafe',
  'Bảng giá Tahu Ngon',
  'Bảng Giá Laika HN',
  'Bảng Giá Maycha 2026',
];

/**
 * Chuẩn hoá tên bảng giá để đối chiếu: bỏ dấu cách thừa, đưa về chữ HOA.
 * (Giữ nguyên dấu tiếng Việt — đủ để phân biệt và khớp.)
 */
export function normalizePriceBookName(name: string): string {
  return (name || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Alias tay cho các trường hợp tên DB ≠ tên cột Lark (không chỉ do hoa/thường
 * hay khoảng trắng). Key = normalize(tên DB) → value = tên cột Lark chính xác.
 */
const PRICE_BOOK_NAME_ALIASES: Record<string, string> = {
  // DB gõ "Haidilao" còn Lark gõ thiếu chữ i: "Hadilao"
  'BẢNG GIÁ HAIDILAO VIỆT NAM': 'Bảng Giá Hadilao Việt Nam',
  // "Bảng giá Haidilao Việt Nam" (biến thể hoa/thường) cũng map về cột trên
  // — normalize đã đưa về cùng key ở trên nên 1 entry là đủ.
};

/** Lookup nhanh: normalize(tên Lark) → tên cột Lark chính xác. */
const NORMALIZED_LARK_COLUMN = new Map<string, string>(
  LARK_PRICE_BOOK_COLUMNS.map((col) => [normalizePriceBookName(col), col]),
);

/**
 * Tra tên cột Lark từ tên bảng giá trong DB.
 * Trả về null nếu không có cột tương ứng → bỏ trống (không đẩy).
 */
export function resolvePriceBookColumn(dbName: string): string | null {
  const norm = normalizePriceBookName(dbName);
  if (PRICE_BOOK_NAME_ALIASES[norm]) return PRICE_BOOK_NAME_ALIASES[norm];
  return NORMALIZED_LARK_COLUMN.get(norm) ?? null;
}

/** Quy đổi boolean → option Single Select trên Lark */
export function toYesNo(value: boolean | null | undefined): string {
  return value ? 'Có' : 'Không';
}
