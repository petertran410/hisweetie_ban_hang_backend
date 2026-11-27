// Đọc giá trị trường Lark Base (v1 + v3) và đổi sang dữ liệu phiếu — hàm thuần, có spec.
import { NPP_STAGE, NppStage } from './new-product-price.constants';

export interface LarkAttachment {
  file_token: string;
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  tmp_url?: string;
}

/** Bỏ dấu + chữ thường + gộp khoảng trắng — để so tên. */
export function foldText(value: unknown): string {
  return larkText(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text / select / rich text / object {text|name|value} → chuỗi. */
export function larkText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) {
    // Rich text: [{type:'text', text:'Siro '}, {type:'text', text:'Đào'}] → ghép nguyên văn.
    const isRich = value.every(
      (item) =>
        item && typeof item === 'object' && 'type' in item && 'text' in item,
    );
    if (isRich)
      return value
        .map((item) => String(item.text ?? ''))
        .join('')
        .trim();
    return value
      .map((item) => larkText(item))
      .filter(Boolean)
      .join(', ')
      .trim();
  }
  if (typeof value === 'object') {
    const v = value as Record<string, any>;
    const candidate = v.text ?? v.name ?? v.value ?? v.label ?? v.en_name;
    if (candidate !== undefined) return larkText(candidate);
    if (Array.isArray(v.text_arr)) return larkText(v.text_arr);
  }
  return '';
}

export function larkNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return larkNumber(value[0]);
  if (typeof value === 'object')
    return larkNumber((value as any).value ?? (value as any).text);
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function larkDate(value: unknown): Date | null {
  const n = larkNumber(value);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function larkBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return larkBool(value[0]);
  return ['true', '1', 'yes', 'có'].includes(foldText(value));
}

/** Trường URL của Lark: {link, text} hoặc chuỗi. */
export function larkUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return larkUrl(value[0]);
  const v = value as Record<string, any>;
  return (v.link || v.text || '').trim() || null;
}

/** Trường người: [{id (open_id), name}] → người đầu tiên. */
export function larkUser(
  value: unknown,
): { openId: string | null; name: string } | null {
  if (!value) return null;
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== 'object') return null;
  const v = first as Record<string, any>;
  const name = String(v.name ?? v.en_name ?? '').trim();
  const openId = v.id ? String(v.id) : null;
  return openId || name ? { openId, name } : null;
}

/** Trường liên kết bản ghi → danh sách {recordId, text}. */
export function larkLinks(
  value: unknown,
): { recordId: string | null; text: string }[] {
  if (!value) return [];
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, any>;
    if (Array.isArray(v.link_record_ids)) {
      return v.link_record_ids.map((id: string) => ({
        recordId: id,
        text: '',
      }));
    }
    return larkLinks([value]);
  }
  if (!Array.isArray(value)) return [];
  const out: { recordId: string | null; text: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, any>;
    const ids: string[] = Array.isArray(v.record_ids)
      ? v.record_ids
      : v.id
        ? [v.id]
        : [];
    const texts: string[] = Array.isArray(v.text_arr)
      ? v.text_arr
      : [larkText(v.text ?? v.name)];
    if (ids.length)
      ids.forEach((id, i) =>
        out.push({ recordId: id, text: texts[i] ?? texts[0] ?? '' }),
      );
    else if (texts[0]) out.push({ recordId: null, text: texts[0] });
  }
  return out;
}

export function larkAttachments(value: unknown): LarkAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (a): a is LarkAttachment =>
      !!a && typeof a === 'object' && typeof (a as any).file_token === 'string',
  );
}

/** Approved / Rejected (Lark) → APPROVED / REJECTED. */
export function larkDecision(value: unknown): 'APPROVED' | 'REJECTED' | null {
  const s = foldText(value);
  if (!s) return null;
  if (s.startsWith('rejected') || s.includes('tu choi')) return 'REJECTED';
  if (s.startsWith('approved') || s.includes('duyet')) return 'APPROVED';
  return null;
}

const STAGE_BY_LABEL: Record<string, NppStage> = {
  'de xuat': NPP_STAGE.PROPOSAL,
  'phong thu mua': NPP_STAGE.PURCHASING,
  'phong ke toan': NPP_STAGE.ACCOUNTING,
  'phong kinh doanh': NPP_STAGE.SALES,
  ceo: NPP_STAGE.CEO,
  'phong du lieu': NPP_STAGE.DATA,
  done: NPP_STAGE.DONE,
  'hoan thanh': NPP_STAGE.DONE,
  ended: NPP_STAGE.ENDED,
  'ket thuc': NPP_STAGE.ENDED,
  'da ket thuc': NPP_STAGE.ENDED,
};

/** Nhãn bước trên trường Flow "Quá trình thực hiện" → stage; null nếu không nhận ra. */
export function larkStage(value: unknown): NppStage | null {
  const s = foldText(value);
  if (!s) return null;
  if (STAGE_BY_LABEL[s]) return STAGE_BY_LABEL[s];
  for (const [label, stage] of Object.entries(STAGE_BY_LABEL)) {
    if (s.includes(label)) return stage;
  }
  return null;
}

/** Lấy giá trị theo tên trường, chấp nhận khác dấu/hoa thường/khoảng trắng. */
export function fieldOf(fields: Record<string, any>, ...names: string[]): any {
  for (const name of names) {
    if (fields[name] !== undefined && fields[name] !== null)
      return fields[name];
  }
  const wanted = new Set(names.map(foldText));
  for (const [key, value] of Object.entries(fields)) {
    if (wanted.has(foldText(key))) return value;
  }
  return undefined;
}
