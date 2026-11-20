import { Prisma } from '@prisma/client';
import {
  normalizeLabel,
  readPaymentVoucherCash,
  readPaymentVoucherDetails,
  type ApprovalFormItem,
  type PaymentVoucherDetails,
} from '../approval-lifecycle/approval-lifecycle.constants';
import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_WEEKLY_STATUS,
  WAREHOUSE_EXPENSE_ITEM,
} from './internal-finance.constants';

/**
 * Tiền ứng xăng xe Kho HN: đơn PHIẾU CHI Lark (Kho Hà Nội / Chi phí kho / Xăng
 * xe) đã duyệt cộng vào tiền ứng; phiếu xăng Kho HN đủ 2 tick trừ vào tiền ứng,
 * không vào Approval tuần, không trừ quỹ (quỹ đã trừ lúc chi đơn PHIẾU CHI).
 */
export const FUEL_ADVANCE_BRANCH_ID = 6;

/** Đơn duyệt / phiếu xăng có ngày đổ từ mốc này mới theo luồng tiền ứng. */
export const FUEL_ADVANCE_FROM = new Date('2026-11-14T00:00:00+07:00');

export const FUEL_ADVANCE_ISSUE_BLOCK =
  'Phiếu xăng Kho HN trừ vào tiền ứng xăng, không chi riêng';

export const FUEL_ADVANCE_BATCH_BLOCK =
  'Batch còn phiếu xăng Kho HN trừ vào tiền ứng xăng: bấm Tổng hợp lại tuần trước khi gửi';

/** Phiếu xăng Kho HN từ mốc: không gom Approval tuần, không chi riêng. */
export const fuelAdvanceEntryWhere: Prisma.InternalFinanceEntryWhereInput = {
  branchId: FUEL_ADVANCE_BRANCH_ID,
  category: INTERNAL_FINANCE_CATEGORY.FUEL,
  occurredAt: { gte: FUEL_ADVANCE_FROM },
};

export function isFuelAdvanceEntry(entry: {
  branchId?: number | null;
  category?: string | null;
  occurredAt?: Date | string | null;
}) {
  return (
    entry.branchId === FUEL_ADVANCE_BRANCH_ID &&
    entry.category === INTERNAL_FINANCE_CATEGORY.FUEL &&
    Boolean(entry.occurredAt) &&
    new Date(entry.occurredAt as Date).getTime() >= FUEL_ADVANCE_FROM.getTime()
  );
}

/**
 * Phiếu xăng đã trừ vào tiền ứng: đủ 2 tick, còn hiệu lực, chưa chi riêng và
 * không nằm trong Approval tuần đã gửi.
 */
export const fuelAdvanceUsedWhere: Prisma.InternalFinanceEntryWhereInput = {
  ...fuelAdvanceEntryWhere,
  direction: 'EXPENSE',
  managerReviewedAt: { not: null },
  accountantReviewedAt: { not: null },
  status: {
    notIn: [
      INTERNAL_FINANCE_STATUS.CANCELLED,
      INTERNAL_FINANCE_STATUS.REJECTED,
    ],
  },
  cashIssued: false,
  cashFlowId: null,
  OR: [
    { weeklyBatchId: null },
    {
      weeklyBatch: {
        status: {
          in: [
            INTERNAL_FINANCE_WEEKLY_STATUS.DRAFT,
            INTERNAL_FINANCE_WEEKLY_STATUS.READY,
          ],
        },
      },
    },
  ],
};

const FUEL_VOUCHER = {
  departments: ['kho ha noi', 'kho hn'],
  expenseType: 'chi phi kho',
  expenseItem: normalizeLabel(WAREHOUSE_EXPENSE_ITEM.FUEL),
};

/** Đơn PHIẾU CHI ứng xăng Kho HN: đúng phòng ban, loại và khoản mục chi phí. */
export function isKhoHnFuelVoucher(
  details: Pick<
    PaymentVoucherDetails,
    'department' | 'expenseType' | 'expenseItem'
  >,
) {
  return (
    FUEL_VOUCHER.departments.includes(normalizeLabel(details.department)) &&
    normalizeLabel(details.expenseType) === FUEL_VOUCHER.expenseType &&
    normalizeLabel(details.expenseItem) === FUEL_VOUCHER.expenseItem
  );
}

export interface FuelAdvanceIn {
  id: number;
  at: Date;
  amount: number;
  description: string | null;
  requesterName: string | null;
  method: string | null;
  cashSource: string | null;
  /** Phần tiền mặt trừ quỹ; null: chuyển khoản, không ghi quỹ. */
  cashAmount: number | null;
}

/** Chữ có trong form đơn ứng xăng, để lọc thô trong DB trước khi đọc form. */
export const FUEL_VOUCHER_FORM_HINT = '%oto%xe%kho%';

/**
 * Bản sao đơn PHIẾU CHI đã duyệt thành một khoản ứng xăng Kho HN; null nếu đơn
 * không đúng phòng ban / loại / khoản mục. Mọi phương thức thanh toán đều tính.
 */
export function fuelAdvanceFromVoucher(row: {
  id: number;
  completedAt: Date | string | null;
  amount: Prisma.Decimal | number | string | null;
  description: string | null;
  requesterName: string | null;
  form: unknown;
}): FuelAdvanceIn | null {
  // Lark lưu form dạng chuỗi JSON; bản cũ có thể đã là mảng.
  let form: ApprovalFormItem[] = [];
  if (Array.isArray(row.form)) form = row.form as ApprovalFormItem[];
  else if (typeof row.form === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.form);
      form = Array.isArray(parsed) ? (parsed as ApprovalFormItem[]) : [];
    } catch {
      form = [];
    }
  }
  const details = readPaymentVoucherDetails(form);
  if (!row.completedAt || !isKhoHnFuelVoucher(details)) return null;
  const amount = details.totalAmount ?? Number(row.amount ?? 0);
  if (!(amount > 0)) return null;
  const cash = readPaymentVoucherCash(form);
  return {
    id: row.id,
    at: new Date(row.completedAt),
    amount,
    description: row.description,
    requesterName: row.requesterName,
    method: details.method,
    cashSource: cash?.cashSource ?? null,
    cashAmount: cash?.amount ?? null,
  };
}

export interface FuelAdvanceUse {
  id: number;
  code: string;
  /** Lúc đủ tick thứ hai: lúc trừ vào tiền ứng. */
  at: Date;
  occurredAt: Date;
  amount: number;
  vehicle: string | null;
  creatorId: number | null;
  creatorName: string | null;
}

export type FuelAdvanceRow =
  | ({ kind: 'ADVANCE'; balance: number } & FuelAdvanceIn)
  | ({ kind: 'FUEL'; balance: number } & FuelAdvanceUse);

/** Lúc phiếu đủ 2 tick (tick sau cùng). */
export function fuelApprovedAt(entry: {
  managerReviewedAt: Date | null;
  accountantReviewedAt: Date | null;
}) {
  const times = [entry.managerReviewedAt, entry.accountantReviewedAt].map(
    (value) => (value ? new Date(value).getTime() : 0),
  );
  return new Date(Math.max(...times));
}

/**
 * Sổ tiền ứng trong khoảng [from, to): số dư đầu kỳ tính từ mốc, các dòng
 * trong kỳ kèm số dư chạy, và tổng phiếu xăng theo người tạo phiếu.
 */
export function buildFuelAdvanceLedger(
  advances: FuelAdvanceIn[],
  usages: FuelAdvanceUse[],
  range: { from?: Date; to?: Date } = {},
) {
  const all = [
    ...advances.map((item) => ({ ...item, kind: 'ADVANCE' as const })),
    ...usages.map((item) => ({ ...item, kind: 'FUEL' as const })),
  ].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      // Cùng lúc: tiền ứng vào trước.
      (a.kind === b.kind ? a.id - b.id : a.kind === 'ADVANCE' ? -1 : 1),
  );
  const signed = (row: (typeof all)[number]) =>
    row.kind === 'ADVANCE' ? row.amount : -row.amount;
  const before = (row: (typeof all)[number]) =>
    Boolean(range.from && row.at.getTime() < range.from.getTime());
  const inRange = (row: (typeof all)[number]) =>
    !before(row) && !(range.to && row.at.getTime() >= range.to.getTime());

  const opening = all.filter(before).reduce((sum, row) => sum + signed(row), 0);
  let balance = opening;
  let advanced = 0;
  let used = 0;
  const rows: FuelAdvanceRow[] = [];
  const creators = new Map<
    string,
    {
      creatorId: number | null;
      creatorName: string | null;
      count: number;
      amount: number;
    }
  >();
  for (const row of all.filter(inRange)) {
    balance += signed(row);
    rows.push({ ...row, balance } as FuelAdvanceRow);
    if (row.kind === 'ADVANCE') {
      advanced += row.amount;
      continue;
    }
    used += row.amount;
    const key = String(row.creatorId ?? row.creatorName ?? '');
    const current = creators.get(key) || {
      creatorId: row.creatorId,
      creatorName: row.creatorName,
      count: 0,
      amount: 0,
    };
    current.count += 1;
    current.amount += row.amount;
    creators.set(key, current);
  }
  return {
    branchId: FUEL_ADVANCE_BRANCH_ID,
    startDate: FUEL_ADVANCE_FROM,
    opening,
    advanced,
    used,
    closing: balance,
    rows,
    byCreator: [...creators.values()].sort((a, b) => b.amount - a.amount),
  };
}
