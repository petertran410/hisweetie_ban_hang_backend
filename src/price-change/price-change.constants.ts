// Hằng số luồng "Thay đổi giá sản phẩm" (chuyển từ Lark Base).

export const PC_STAGE = {
  PROPOSAL: 'PROPOSAL',
  CHIEF_ACCOUNTANT: 'CHIEF_ACCOUNTANT',
  CEO: 'CEO',
  DATA: 'DATA',
  DONE: 'DONE',
  ENDED: 'ENDED',
} as const;
export type PcStage = (typeof PC_STAGE)[keyof typeof PC_STAGE];

export const STAGE_LABELS: Record<PcStage, string> = {
  PROPOSAL: 'Đề xuất',
  CHIEF_ACCOUNTANT: 'Kế toán trưởng',
  CEO: 'CEO',
  DATA: 'Phòng Dữ Liệu',
  DONE: 'Hoàn thành',
  ENDED: 'Đã kết thúc',
};

export const FINAL_STAGES: PcStage[] = [PC_STAGE.DONE, PC_STAGE.ENDED];

export const PC_STATUS = {
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type PcStatus = (typeof PC_STATUS)[keyof typeof PC_STATUS];

export const PC_DECISION = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type PcDecision = (typeof PC_DECISION)[keyof typeof PC_DECISION];

/** Nhóm người duyệt (cấu hình riêng của luồng này). */
export const PC_GROUP = {
  CHIEF_ACCOUNTANT: 'CHIEF_ACCOUNTANT',
  CEO: 'CEO',
  DATA: 'DATA',
} as const;
export type PcGroup = (typeof PC_GROUP)[keyof typeof PC_GROUP];
export const PC_GROUPS = Object.values(PC_GROUP) as PcGroup[];

export const GROUP_LABELS: Record<PcGroup, string> = {
  CHIEF_ACCOUNTANT: 'Kế toán trưởng',
  CEO: 'CEO',
  DATA: 'Phòng Dữ Liệu',
};

/** Bước → nhóm xử lý (Đề xuất do người tạo xử lý). */
export const STAGE_GROUP: Partial<Record<PcStage, PcGroup>> = {
  CHIEF_ACCOUNTANT: PC_GROUP.CHIEF_ACCOUNTANT,
  CEO: PC_GROUP.CEO,
  DATA: PC_GROUP.DATA,
};

export const PC_EVENT = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  SUBMITTED: 'SUBMITTED',
  KTT_DECIDED: 'KTT_DECIDED',
  CEO_DECIDED: 'CEO_DECIDED',
  SENT_BACK: 'SENT_BACK',
  APPLIED: 'APPLIED',
  ENDED: 'ENDED',
  COMMENT: 'COMMENT',
  IMPORTED: 'IMPORTED',
  NOTIFY: 'NOTIFY',
} as const;

export const PC_ACTION = {
  EDIT: 'EDIT',
  SUBMIT: 'SUBMIT',
  KTT_DECIDE: 'KTT_DECIDE',
  CEO_DECIDE: 'CEO_DECIDE',
  APPLY: 'APPLY',
  SEND_BACK: 'SEND_BACK',
  END: 'END',
  COMMENT: 'COMMENT',
} as const;
export type PcAction = (typeof PC_ACTION)[keyof typeof PC_ACTION];

export const CODE_PREFIX = 'TDG';
/** Id ảo của "Bảng giá chung" = product.basePrice (cùng quy ước price-books.service). */
export const BASE_PRICE_BOOK_ID = 0;
export const BASE_PRICE_BOOK_NAME = 'Bảng giá chung';
export const UPLOAD_SUBFOLDER = 'price-change';
export const FRONTEND_PATH = '/san-pham/thay-doi-gia';
export const MAX_ITEMS = 300;
/** Khóa "đang áp dụng" hết hạn sau 5 phút (máy chủ chết giữa chừng thì bấm lại được). */
export const APPLY_LOCK_MS = 5 * 60 * 1000;

export const PERM = {
  VIEW: 'price_change:view',
  CREATE: 'price_change:create',
  CONFIG: 'price_change:config',
  IMPORT: 'price_change:import',
} as const;

/** Một ô giá vốn của dòng sản phẩm. newCost null = không đổi. */
export interface CostLine {
  branchId: number;
  branchName: string;
  oldCost: number | null;
  newCost: number | null;
}

/** Một ô giá bán của dòng sản phẩm. priceBookId 0 = Bảng giá chung. */
export interface PriceLine {
  priceBookId: number;
  priceBookName: string;
  oldPrice: number | null;
  newPrice: number | null;
}
