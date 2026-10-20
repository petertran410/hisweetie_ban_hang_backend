import { BadRequestException } from '@nestjs/common';
import {
  CASH_ADVANCE_GRACE_DAYS,
  CASH_ADVANCE_MAX_RANGE_DAYS,
  CASH_ADVANCE_PERIOD_MODE,
} from './cash-advance.constants';

// Mọi ngày của tạm ứng là ngày Việt Nam dạng yyyy-mm-dd ("date key").
// Không import sổ quỹ để file này dùng được trong InternalFundLedgerService.

const DAY_MS = 86400000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày Việt Nam (yyyy-mm-dd) của một mốc thời gian; chuỗi yyyy-mm-dd giữ nguyên. */
export function vnDateKey(value: Date | string): string {
  if (typeof value === 'string' && DATE_KEY.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('Ngày không hợp lệ');
  return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

/** Giá trị lưu vào cột @db.Date. */
export const dateKeyToDb = (key: string) => new Date(`${key}T00:00:00Z`);

/** Đọc lại cột @db.Date (Prisma trả về nửa đêm UTC). */
export const dbDateKey = (value: Date) =>
  new Date(value).toISOString().slice(0, 10);

/** Đầu ngày theo giờ Việt Nam. */
export const vnDayStart = (key: string) => new Date(`${key}T00:00:00+07:00`);

export const addDaysKey = (key: string, days: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

export const vnTodayKey = (now = new Date()) => vnDateKey(now);

/** dd/mm/yyyy của date key. */
export const formatDateKey = (key: string) => {
  const [year, month, day] = key.split('-');
  return `${day}/${month}/${year}`;
};

/** Tuần ISO (Thứ hai–Chủ nhật) của ngày yyyy-mm-dd. */
export function isoWeekOf(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  // Thứ năm cùng tuần quyết định tuần thuộc năm nào.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(
    ((date.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7,
  );
  return { year, week };
}

/** Số tuần ISO của năm (52 hoặc 53). */
export const isoWeeksInYear = (year: number) => isoWeekOf(`${year}-12-28`).week;

/** Thứ hai và Chủ nhật của tuần ISO. */
export function isoWeekRange(year: number, week: number) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(
    jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (week - 1) * 7,
  );
  const from = monday.toISOString().slice(0, 10);
  return { from, to: addDaysKey(from, 6) };
}

export interface CashAdvancePeriodInput {
  periodMode: string;
  periodYear?: number | null;
  periodWeek?: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
}

export interface CashAdvancePeriod {
  mode: string;
  year: number | null;
  week: number | null;
  from: string;
  to: string;
}

/** Kỳ tạm ứng: theo tuần thì server tự tính Thứ hai–Chủ nhật. */
export function derivePeriod(input: CashAdvancePeriodInput): CashAdvancePeriod {
  if (input.periodMode === CASH_ADVANCE_PERIOD_MODE.WEEK) {
    const year = Number(input.periodYear);
    const week = Number(input.periodWeek);
    if (
      !Number.isInteger(year) ||
      year < 2020 ||
      year > 2100 ||
      !Number.isInteger(week) ||
      week < 1 ||
      week > isoWeeksInYear(year)
    )
      throw new BadRequestException('Tuần tạm ứng không hợp lệ');
    return { mode: input.periodMode, year, week, ...isoWeekRange(year, week) };
  }
  if (input.periodMode !== CASH_ADVANCE_PERIOD_MODE.RANGE)
    throw new BadRequestException('Kiểu kỳ tạm ứng không hợp lệ');
  if (!input.periodFrom || !input.periodTo)
    throw new BadRequestException('Cần chọn từ ngày và đến ngày');
  const from = vnDateKey(input.periodFrom);
  const to = vnDateKey(input.periodTo);
  if (from > to)
    throw new BadRequestException('Từ ngày phải trước hoặc bằng đến ngày');
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days > CASH_ADVANCE_MAX_RANGE_DAYS)
    throw new BadRequestException(
      `Kỳ tạm ứng tối đa ${CASH_ADVANCE_MAX_RANGE_DAYS} ngày`,
    );
  return { mode: input.periodMode, year: null, week: null, from, to };
}

/** Hạn làm hoàn ứng: hết kỳ + 5 ngày ân hạn (vẫn được làm trong ngày hạn). */
export const refundDueKey = (periodToKey: string) =>
  addDaysKey(periodToKey, CASH_ADVANCE_GRACE_DAYS);

/** "Tuần 43/2026 (19/10 – 25/10/2026)" hoặc "19/10/2026 – 25/10/2026". */
export function periodLabel(advance: {
  periodMode: string;
  periodYear?: number | null;
  periodWeek?: number | null;
  periodFrom: Date | string;
  periodTo: Date | string;
}) {
  const from = dbDateKey(new Date(advance.periodFrom));
  const to = dbDateKey(new Date(advance.periodTo));
  if (
    advance.periodMode === CASH_ADVANCE_PERIOD_MODE.WEEK &&
    advance.periodWeek &&
    advance.periodYear
  )
    return `Tuần ${advance.periodWeek}/${advance.periodYear} (${formatDateKey(from).slice(0, 5)} – ${formatDateKey(to)})`;
  return `${formatDateKey(from)} – ${formatDateKey(to)}`;
}
