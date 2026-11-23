import type { AiScope } from '../ai-scope';
import type { AiToolDeps } from './deps';

export type { AiScope } from '../ai-scope';

export type AiToolContext = { scope: AiScope; now: Date; deps: AiToolDeps };

/**
 * Một công cụ chỉ đọc của trợ lý. `run` gọi lại service sẵn có với đúng actor / currentUser
 * như controller, và chỉ trả trường cần thiết: không id nội bộ, không SĐT, không địa chỉ.
 */
export type AiTool = {
  name: string;
  /** Dòng trạng thái khi công cụ chạy, ví dụ "Đang tra cứu hoá đơn". */
  label: string;
  /** Mô tả cho model; hàm khi phụ thuộc quyền người hỏi. */
  description: string | ((scope: AiScope) => string);
  /** JSON Schema của tham số. */
  parameters:
    | Record<string, unknown>
    | ((scope: AiScope) => Record<string, unknown>);
  available: (scope: AiScope) => boolean;
  run: (
    context: AiToolContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

const MAX_TEXT = 200;

export const num = (value: unknown) =>
  Math.round(Number(value ?? 0) * 100) / 100;

/**
 * Chuỗi cắt còn `max` ký tự, gộp khoảng trắng. Không cắt đôi emoji (nửa cặp surrogate làm JSON gửi
 * model bị Anthropic từ chối: "unexpected end of hex escape").
 */
export const clip = (value: string | null | undefined, max = MAX_TEXT) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max
    ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
    : text || null;
};

/** Ngày theo giờ Việt Nam dạng YYYY-MM-DD. */
export const vnDayKey = (value: Date) =>
  new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Chuỗi tham số `args[key]` đã trim, hoặc undefined. */
export const str = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Khoảng ngày from/to (YYYY-MM-DD, theo giờ VN) từ tham số; thiếu thì mặc định từ đầu tháng
 * này đến hôm nay. Trả lỗi đọc được cho model khi sai định dạng.
 */
export function dateRange(
  args: Record<string, unknown>,
  now: Date,
): { from: string; to: string } | { error: string } {
  const today = vnDayKey(now);
  const from = str(args, 'from') ?? `${today.slice(0, 8)}01`;
  const to = str(args, 'to') ?? today;
  if (!DAY.test(from) || !DAY.test(to))
    return { error: 'invalid_date: dùng dạng YYYY-MM-DD' };
  if (from > to) return { error: 'invalid_range: from phải trước to' };
  return { from, to };
}

export const rangeParameters = {
  from: {
    type: 'string',
    description:
      'Từ ngày (YYYY-MM-DD, giờ Việt Nam). Bỏ trống = ngày đầu tháng này.',
  },
  to: {
    type: 'string',
    description: 'Đến ngày (YYYY-MM-DD, gồm cả ngày này). Bỏ trống = hôm nay.',
  },
};
