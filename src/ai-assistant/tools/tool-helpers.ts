import type { AiScope } from './common';
import { vnDayKey } from './common';

/** Danh sách trả cho model tối đa chừng này dòng. */
export const MAX_ROWS = 20;

/**
 * Số lời gọi service (mỗi lời gọi list = 2 truy vấn) một công cụ chạy cùng lúc. Cả POS dùng chung
 * pool kết nối nhỏ (DATABASE_URL connection_limit): một câu hỏi về lead không được chiếm hết.
 */
export const TOOL_QUERY_CONCURRENCY = 2;

/**
 * Giới hạn số việc chạy cùng lúc; việc thừa xếp hàng theo thứ tự. Việc xong trao chỗ thẳng cho
 * việc đang chờ (không trả về rồi giành lại), nên không bao giờ vượt `max`.
 */
export function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Đầu / cuối ngày theo giờ Việt Nam, dạng ISO để truyền cho service như frontend. */
export const vnStartIso = (day: string) => `${day}T00:00:00.000+07:00`;
export const vnEndIso = (day: string) => `${day}T23:59:59.999+07:00`;

/** Số tiền VNĐ làm tròn đồng. */
export const money = (value: unknown) => Math.round(Number(value ?? 0));

/** Ngày giờ → YYYY-MM-DD theo giờ Việt Nam. */
export const day = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : vnDayKey(date);
};

export const bool = (args: Record<string, unknown>, key: string) =>
  args[key] === true || args[key] === 'true';

/** Số dòng model xin, kẹp trong 1..MAX_ROWS. */
export function limitOf(args: Record<string, unknown>, fallback = 10) {
  const value = Math.trunc(Number(args.limit));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, MAX_ROWS);
}

/** Danh sách giá trị hợp lệ từ mảng hoặc chuỗi phân tách dấu phẩy. */
export function pickList<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] | undefined {
  const raw = args[key];
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const list = items
    .map((item) => String(item).trim())
    .filter((item): item is T => (allowed as readonly string[]).includes(item));
  return list.length ? [...new Set(list)] : undefined;
}

/** Chi nhánh đang chọn trên POS khi model yêu cầu `currentBranchOnly`. */
export const branchOf = (scope: AiScope, args: Record<string, unknown>) =>
  bool(args, 'currentBranchOnly') ? (scope.branchId ?? undefined) : undefined;

export const limitParameter = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_ROWS,
  description: `Số dòng tối đa trong danh sách (1–${MAX_ROWS}, mặc định 10).`,
};

export const currentBranchParameter = {
  type: 'boolean',
  description:
    'true = chỉ tính chi nhánh đang chọn trên POS. Bỏ trống = mọi chi nhánh.',
};

/** Thêm tổng số dòng và cờ còn dòng chưa hiện. */
export const listMeta = (shown: number, total: number) => ({
  totalRows: total,
  moreRows: total > shown,
});
