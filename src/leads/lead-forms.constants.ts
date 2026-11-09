// Form thu thập lead: trường Lead có sẵn (bật/tắt, bắt buộc) + câu hỏi thêm (key "q_…")
export const LEAD_FORM_BUILTIN_KEYS = [
  'name',
  'phone',
  'zaloPhone',
  'province',
  'category',
  'need',
] as const;
export type LeadFormBuiltinKey = (typeof LEAD_FORM_BUILTIN_KEYS)[number];

export const LEAD_FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'select',
  'multiselect',
] as const;

export const LEAD_FORM_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;
export const CUSTOM_FIELD_KEY = /^q_[a-z0-9]{1,30}$/;

export interface LeadFormProvince {
  provinceCode: string;
  provinceName: string | null;
  wardCode: string | null;
  wardName: string | null;
}

export interface LeadFormField {
  key: string;
  label: string;
  enabled: boolean;
  required: boolean;
  type?: string;
  options?: string[];
  /** Ẩn khỏi form khách: lead tự nhận defaultValue */
  hidden?: boolean;
  /** Giá trị mặc định: chuỗi / mảng (chọn nhiều) / khu vực. Trường hiện → điền sẵn cho khách */
  defaultValue?: string | string[] | LeadFormProvince;
}

// Họ tên, SĐT: khách luôn tự nhập (không ẩn, không giá trị mặc định)
export const LEAD_FORM_NO_DEFAULT_KEYS = ['name', 'phone'];

export const DEFAULT_LEAD_FORM_FIELDS: LeadFormField[] = [
  { key: 'name', label: 'Họ tên', enabled: true, required: true },
  { key: 'phone', label: 'Số điện thoại', enabled: true, required: true },
  { key: 'zaloPhone', label: 'SĐT Zalo', enabled: false, required: false },
  { key: 'province', label: 'Khu vực', enabled: true, required: false },
  { key: 'category', label: 'Bạn là', enabled: true, required: true },
  { key: 'need', label: 'Nhu cầu', enabled: true, required: false },
];

// Chống spam: số lượt gửi tối đa trong cửa sổ thời gian
export const SUBMIT_LIMIT_PER_IP = { max: 5, windowMs: 10 * 60_000 };
export const SUBMIT_LIMIT_PER_PHONE = { max: 3, windowMs: 60 * 60_000 };
