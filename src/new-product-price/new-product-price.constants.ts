// Hằng số luồng "Bảng giá sản phẩm mới" (chuyển từ Lark Base).

export const NPP_STAGE = {
  PROPOSAL: 'PROPOSAL',
  PURCHASING: 'PURCHASING',
  ACCOUNTING: 'ACCOUNTING',
  SALES: 'SALES',
  CEO: 'CEO',
  DATA: 'DATA',
  DONE: 'DONE',
  ENDED: 'ENDED',
} as const;
export type NppStage = (typeof NPP_STAGE)[keyof typeof NPP_STAGE];

/** Thứ tự các bước (không gồm ENDED). */
export const STAGE_ORDER: NppStage[] = [
  NPP_STAGE.PROPOSAL,
  NPP_STAGE.PURCHASING,
  NPP_STAGE.ACCOUNTING,
  NPP_STAGE.SALES,
  NPP_STAGE.CEO,
  NPP_STAGE.DATA,
  NPP_STAGE.DONE,
];

export const STAGE_LABELS: Record<NppStage, string> = {
  PROPOSAL: 'Đề xuất',
  PURCHASING: 'Phòng Thu Mua',
  ACCOUNTING: 'Phòng Kế Toán',
  SALES: 'Phòng Kinh Doanh',
  CEO: 'CEO',
  DATA: 'Phòng Dữ Liệu',
  DONE: 'Hoàn thành',
  ENDED: 'Đã kết thúc',
};

export const FINAL_STAGES: NppStage[] = [NPP_STAGE.DONE, NPP_STAGE.ENDED];

export const NPP_STATUS = {
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type NppStatus = (typeof NPP_STATUS)[keyof typeof NPP_STATUS];

export const STATUS_LABELS: Record<NppStatus, string> = {
  UNDER_REVIEW: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
};

export const NPP_DECISION = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type NppDecision = (typeof NPP_DECISION)[keyof typeof NPP_DECISION];

/** Nhóm người duyệt (cấu hình), tương đương bảng "Cấu Hình Duyệt" trên Lark. */
export const NPP_GROUP = {
  PURCHASING: 'PURCHASING',
  ACCOUNTING: 'ACCOUNTING',
  CHIEF_ACCOUNTANT: 'CHIEF_ACCOUNTANT',
  SALES: 'SALES',
  CEO: 'CEO',
  DATA: 'DATA',
} as const;
export type NppGroup = (typeof NPP_GROUP)[keyof typeof NPP_GROUP];
export const NPP_GROUPS = Object.values(NPP_GROUP) as NppGroup[];

export const GROUP_LABELS: Record<NppGroup, string> = {
  PURCHASING: 'Phòng Thu Mua',
  ACCOUNTING: 'Phòng Kế Toán',
  CHIEF_ACCOUNTANT: 'Kế toán trưởng',
  SALES: 'Phòng Kinh Doanh',
  CEO: 'CEO',
  DATA: 'Phòng Dữ Liệu',
};

/** Bước → nhóm người xử lý (Đề xuất do người tạo xử lý). */
export const STAGE_GROUP: Partial<Record<NppStage, NppGroup>> = {
  PURCHASING: NPP_GROUP.PURCHASING,
  ACCOUNTING: NPP_GROUP.ACCOUNTING,
  SALES: NPP_GROUP.SALES,
  CEO: NPP_GROUP.CEO,
  DATA: NPP_GROUP.DATA,
};

export const NPP_EVENT = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  STAGE_COMPLETED: 'STAGE_COMPLETED',
  SENT_BACK: 'SENT_BACK',
  KTT_SENT: 'KTT_SENT',
  KTT_DECIDED: 'KTT_DECIDED',
  CEO_DECIDED: 'CEO_DECIDED',
  APPLIED: 'APPLIED',
  ENDED: 'ENDED',
  COMMENT: 'COMMENT',
  IMPORTED: 'IMPORTED',
  NOTIFY: 'NOTIFY',
} as const;

export const NPP_ACTION = {
  COMPLETE: 'COMPLETE',
  SEND_BACK: 'SEND_BACK',
  SEND_KTT: 'SEND_KTT',
  KTT_DECIDE: 'KTT_DECIDE',
  CEO_DECIDE: 'CEO_DECIDE',
  APPLY: 'APPLY',
  END: 'END',
  COMMENT: 'COMMENT',
} as const;
export type NppAction = (typeof NPP_ACTION)[keyof typeof NPP_ACTION];

export const CODE_PREFIX = 'SPM';
export const VAT_DIVISOR = 1.08;
export const MANUFACTURED_PARENT = 'Hàng sản xuất';
export const DOMESTIC_ORIGIN = 'Nội địa';
export const UPLOAD_SUBFOLDER = 'new-product-price';
export const FRONTEND_PATH = '/san-pham/bang-gia-san-pham-moi';

export const PERM = {
  VIEW: 'new_product_price:view',
  CREATE: 'new_product_price:create',
  CONFIG: 'new_product_price:config',
  IMPORT: 'new_product_price:import',
} as const;

/** Đích áp dụng giá bán khi tạo sản phẩm: "Bảng giá chung" (basePrice) hoặc id bảng giá. */
export const BASE_PRICE_TARGET = 'BASE_PRICE';

export const PRICE_TARGET_KEYS = [
  'HN_RETAIL',
  'HN_WHOLESALE',
  'SG_RETAIL',
  'SG_WHOLESALE',
  'DLCL',
  'SHOPEE',
] as const;
export type PriceTargetKey = (typeof PRICE_TARGET_KEYS)[number];

export const PRICE_TARGET_FIELD: Record<PriceTargetKey, string> = {
  HN_RETAIL: 'priceHnRetail',
  HN_WHOLESALE: 'priceHnWholesale',
  SG_RETAIL: 'priceSgRetail',
  SG_WHOLESALE: 'priceSgWholesale',
  DLCL: 'priceDlcl',
  SHOPEE: 'priceShopee',
};

export const PRICE_TARGET_LABELS: Record<PriceTargetKey, string> = {
  HN_RETAIL: 'HN - Giá Lẻ',
  HN_WHOLESALE: 'HN - Giá Buôn',
  SG_RETAIL: 'SG - Giá Lẻ',
  SG_WHOLESALE: 'SG - Giá Buôn',
  DLCL: 'Giá ĐLCL',
  SHOPEE: 'Giá Shopee',
};

/** Tên bảng giá mặc định (dò theo tên chuẩn hóa) khi chưa cấu hình. */
export const DEFAULT_PRICE_TARGET_NAMES: Record<PriceTargetKey, string> = {
  HN_RETAIL: BASE_PRICE_TARGET,
  HN_WHOLESALE: 'Bảng Giá Buôn HN',
  SG_RETAIL: 'Bảng Giá Lẻ HCM',
  SG_WHOLESALE: 'Bảng Giá Buôn HCM',
  DLCL: 'Bảng Giá Chiến Lược',
  SHOPEE: 'Bảng Giá Shopee',
};

export const COST_GROUP_KEYS = ['HN', 'SG', 'DT'] as const;
export type CostGroupKey = (typeof COST_GROUP_KEYS)[number];

export const COST_GROUP_FIELD: Record<CostGroupKey, string> = {
  HN: 'cogsHn',
  SG: 'cogsSg',
  DT: 'cogsDt',
};

export const COST_GROUP_LABELS: Record<CostGroupKey, string> = {
  HN: 'Giá vốn Hà Nội',
  SG: 'Giá vốn Sài Gòn',
  DT: 'Giá vốn CH Diệp Trà',
};

/** Từ khóa dò chi nhánh mặc định cho từng nhóm giá vốn (theo tên chi nhánh). */
export const DEFAULT_COST_BRANCH_KEYWORDS: Record<CostGroupKey, string[]> = {
  HN: ['hà nội', 'ha noi'],
  SG: ['sài gòn', 'sai gon', 'hcm', 'hồ chí minh'],
  DT: ['diệp trà', 'diep tra'],
};

/** Nhãn tiếng Việt của các trường (thông báo lỗi, lịch sử). */
export const FIELD_LABELS: Record<string, string> = {
  productName: 'Tên hàng hóa',
  parentName: 'Loại hàng',
  childName: 'Danh mục hàng',
  middleName: 'Nguồn gốc hàng',
  tradeMarkId: 'Thương hiệu',
  unit: 'Đơn vị tính',
  netWeightGram: 'Khối lượng tịnh (gram)',
  description: 'Mô tả sản phẩm',
  costApproverId: 'Người duyệt giá cost',
  supplierId: 'Nhà cung cấp',
  factoryId: 'Nhà máy',
  moqCartons: 'MOQ (Thùng)',
  deliveryTerms: 'Điều kiện giao hàng',
  importName: 'Tên hàng nhập khẩu',
  arrivalDate: 'Thời gian hàng về',
  launchDate: 'Thời gian ra mắt',
  packingSpec: 'Quy cách đóng gói',
  goodsPrice: 'Giá hàng',
  exchangeRate: 'Tỉ giá',
  vatTax: 'Thuế GTGT',
  importTax: 'Thuế nhập khẩu',
  overheadCost: 'Chi phí chung',
  costHn: 'Cost Hà Nội (trước VAT)',
  costSg: 'Cost Sài Gòn (trước VAT)',
  misaCode: 'Mã Misa',
  cogsHn: 'Giá vốn Hà Nội',
  cogsSg: 'Giá vốn Sài Gòn',
  cogsDt: 'Giá vốn CH Diệp Trà',
  priceHnRetail: 'HN - Giá Lẻ',
  priceHnWholesale: 'HN - Giá Buôn',
  priceSgRetail: 'SG - Giá Lẻ',
  priceSgWholesale: 'SG - Giá Buôn',
  priceDlcl: 'Giá ĐLCL',
  priceShopee: 'Giá Shopee',
  priceOem: 'Giá OEM',
  oemPriceBookId: 'Bảng giá OEM',
  oemCustomers: 'Khách OEM',
  note: 'Ghi chú',
  images: 'Hình ảnh sản phẩm',
  documents: 'Tài liệu đính kèm',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] || field;
}
