export const QUOTE_LAYOUTS = ['classic', 'brand'] as const;
export const QUOTE_REGIONS = ['HN', 'SG', 'ALL'] as const;
export const QUOTE_CATEGORIES = [
  'frozen_topping',
  'ambient_topping',
  'powder',
  'jam_syrup',
] as const;
export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Nháp → Đã gửi → Khách chấp nhận / Từ chối / Hết hạn. */
export const QUOTE_STATUS_NEXT: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: [],
  expired: [],
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Nháp',
  sent: 'Đã gửi',
  accepted: 'Khách chấp nhận',
  rejected: 'Từ chối',
  expired: 'Hết hạn',
};

export const QUOTE_REGION_LABEL: Record<
  (typeof QUOTE_REGIONS)[number],
  string
> = {
  HN: 'Hà Nội',
  SG: 'Sài Gòn',
  ALL: 'Toàn quốc',
};

/** Quyền: có quotes:view_all (Trưởng Bộ Phận Sale) → xem mọi báo giá; không có → chỉ báo giá mình tạo. */
export const QUOTES_VIEW_ALL = 'quotes:view_all';
