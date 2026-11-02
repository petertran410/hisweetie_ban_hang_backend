export const LEAD_SOURCES = [
  'facebook',
  'tiktok',
  'shopee',
  'zalo_oa',
  'website',
] as const;
export const LEAD_CATEGORIES = [
  'cafe',
  'chain',
  'distributor',
  'training',
] as const;
export const LEAD_STATUSES = [
  'new',
  'caring',
  'handed_over',
  'converted',
  'cancelled',
] as const;

export const LEAD_CATEGORY_LABEL: Record<string, string> = {
  cafe: 'Khách quán',
  chain: 'Khách chuỗi',
  distributor: 'Đại lý nguyên liệu',
  training: 'Đào tạo/Set up',
};

export type HandoverStep = 'lark' | 'friend' | 'greeting';
export const HANDOVER_STEPS: HandoverStep[] = ['lark', 'friend', 'greeting'];
export type StepResult = {
  status: 'pending' | 'ok' | 'failed';
  at?: string;
  error?: string;
};

// Mẫu mặc định (Cài đặt → Mẫu tin Lead ghi đè); biến: {tên khách} {tên sale} {sđt} {phân loại} {nhu cầu} {ghi chú} {link}
export const DEFAULT_LEAD_TEMPLATES = {
  greeting:
    'Dạ em chào {tên khách}, em là {tên sale} từ LerMao. Em đã nhận được thông tin của mình từ bạn CSKH, em kết bạn Zalo để tiện tư vấn sản phẩm và báo giá cho mình ạ.',
  friend: 'Em là {tên sale} - LerMao',
  lark:
    'Lead mới chuyển cho {tên sale}\n' +
    'Khách: {tên khách}\nSĐT: {sđt}\nPhân loại: {phân loại}\nNhu cầu: {nhu cầu}\nGhi chú CSKH: {ghi chú}\nMở lead: {link}',
};

export function renderLeadTemplate(
  tpl: string,
  vars: Record<string, string>,
): string {
  return tpl
    .replace(/\{([^{}]+)\}/g, (m, key: string) => (key in vars ? vars[key] : m))
    .trim();
}
