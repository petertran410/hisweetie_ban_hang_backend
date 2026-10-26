import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { fundClosingDate } from '../internal-fund/internal-fund-ledger.service';
import { readNumber, readText } from './legacy-fund-reconcile';
import { plateHints, vnDay } from './lark-twin-dedupe';

/**
 * Tuần Approval phiếu chi kho Lark đã duyệt nhưng POS ghi quỹ thiếu: Lark duyệt
 * (và kho chi) cả tuần, còn POS chỉ ghi Đã chi cho phiếu đủ hai tick. Phiếu xe
 * POS giữ thay dòng phiếu chi Lark lúc đồng bộ không mang tick nên bị gỡ khỏi
 * tuần. Theo LarkBase: phiếu Lark tính vào tuần thì POS tick đủ, gắn vào tuần,
 * ghi Đã chi và trừ quỹ vào ngày duyệt.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface LarkWeekRow {
  recordId: string;
  ms: number | null;
  day: string | null;
  amount: number;
  week: number;
  year: number;
  content: string;
  note: string;
  managerChecked: boolean;
  accountantChecked: boolean;
}

const text = (fields: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) {
    const value = readText(fields[name]).trim();
    if (value) return value;
  }
  return '';
};

const checked = (value: unknown) =>
  value === true || readText(value).toLowerCase() === 'true';

export function mapLarkWeekRow(record: {
  recordId: string;
  fields: Record<string, unknown>;
}): LarkWeekRow {
  const ms = readNumber(record.fields['NĂM/THÁNG/NGÀY']);
  return {
    recordId: record.recordId,
    ms: ms > 0 ? ms : null,
    day: ms > 0 ? vnDay(new Date(ms)) : null,
    amount: readNumber(record.fields['THÀNH TIỀN']),
    week: readNumber(record.fields['Tuần']),
    // Cột "Năm" của API liệt kê trả mã lựa chọn, không phải chữ: lấy năm từ
    // ngày giao dịch như công thức YEAR() của Lark (giờ VN).
    year: ms > 0 ? Number(vnDay(new Date(ms)).slice(0, 4)) : 0,
    content: text(record.fields, 'NỘI DUNG', 'Nội Dung'),
    note: text(record.fields, 'GHI CHÚ', 'Ghi chú'),
    managerChecked: checked(record.fields['Quản Lý Kho']),
    accountantChecked: checked(record.fields['Kế Toán Kho']),
  };
}

const entrySelect = {
  id: true,
  code: true,
  branchId: true,
  amount: true,
  occurredAt: true,
  status: true,
  sourceType: true,
  sourceKey: true,
  category: true,
  description: true,
  note: true,
  cancelReason: true,
  cashIssued: true,
  cashFlowId: true,
  weeklyBatchId: true,
  sourceSnapshot: true,
  managerReviewedAt: true,
  accountantReviewedAt: true,
  fundTransaction: { select: { id: true, status: true } },
} satisfies Prisma.InternalFinanceEntrySelect;

export type WeekEntry = Prisma.InternalFinanceEntryGetPayload<{
  select: typeof entrySelect;
}>;

export type RowStatus =
  | 'issued'
  | 'toFix'
  | 'otherBatch'
  | 'cancelled'
  | 'notFound';

export const STATUS_LABEL: Record<RowStatus, string> = {
  issued: 'Đã chi trên POS (đúng)',
  toFix: 'SẼ SỬA: tick đủ, gắn vào tuần, Đã chi + trừ quỹ',
  otherBatch: 'Đang ở tuần khác trên POS (không tự sửa)',
  cancelled: 'Đã hủy trên POS (không tự sửa)',
  notFound: 'Không tìm thấy phiếu trên POS',
};

export interface WeekLine {
  lark: LarkWeekRow;
  entry: WeekEntry | null;
  via: 'record' | 'merged' | 'vehicle' | null;
  status: RowStatus;
  /** Phiếu có dấu "đã trừ quỹ trên Lark": chỉ tick Đã chi, không trừ quỹ. */
  ledgerRecorded: boolean;
}

const ledgerRecorded = (entry: { sourceSnapshot: unknown }) =>
  Boolean(
    entry.sourceSnapshot &&
    typeof entry.sourceSnapshot === 'object' &&
    (entry.sourceSnapshot as { larkLedgerRecorded?: unknown })
      .larkLedgerRecorded === true,
  );

/** Ghép dòng Lark với phiếu xe POS giữ thay nó: cùng giây → biển số → duy nhất. */
export function matchVehicle(
  row: LarkWeekRow,
  vehicles: WeekEntry[],
  used: Set<number>,
) {
  const sameAmount = vehicles.filter(
    (v) => !used.has(v.id) && Number(v.amount) === row.amount,
  );
  if (row.ms) {
    const second = Math.floor(row.ms / 1000);
    const exact = sameAmount.filter(
      (v) => Math.floor(v.occurredAt.getTime() / 1000) === second,
    );
    if (exact.length === 1) return exact[0];
  }
  const sameDay = sameAmount.filter((v) => vnDay(v.occurredAt) === row.day);
  const hints = plateHints(`${row.content} ${row.note}`);
  if (hints.length) {
    // Ghi biển thì chỉ nhận đúng xe đó; lệch biển (khác giờ) không ghép.
    const byPlate = sameDay.filter((v) => {
      const plate = plateHints(v.description || '');
      return hints.some((hint) => plate.some((p) => p.includes(hint)));
    });
    return byPlate.length === 1 ? byPlate[0] : null;
  }
  return sameDay.length === 1 ? sameDay[0] : null;
}

export interface WeekPlan {
  week: number;
  year: number;
  larkAmount: number;
  instanceCode: string;
  request: { id: number; completedAt: Date | null } | null;
  batch: { id: number; code: string; status: string } | null;
  /** Tổng dòng Lark của tuần: tất cả / chỉ dòng đủ hai tick. */
  larkAllRows: number;
  larkCheckedRows: number;
  /** Tập dòng Lark dùng để đối chiếu (tập có tổng khớp số tiền Approval). */
  rowSet: 'all' | 'checked' | 'none';
  posPosted: number;
  lines: WeekLine[];
}

export async function planApprovedWeeks(
  db: Db,
  input: {
    branchId: number;
    tableId: string;
    baseToken: string;
    year: number;
    weeks: Array<{ week: number; amount: number; instanceCode: string }>;
    larkRows: LarkWeekRow[];
  },
): Promise<WeekPlan[]> {
  const prefix = `LARK:${input.baseToken}:${input.tableId}:`;
  const plans: WeekPlan[] = [];
  const used = new Set<number>();
  for (const week of input.weeks) {
    const all = input.larkRows.filter(
      (row) => row.year === input.year && row.week === week.week,
    );
    const checkedRows = all.filter(
      (row) => row.managerChecked && row.accountantChecked,
    );
    const sum = (rows: LarkWeekRow[]) =>
      rows.reduce((total, row) => total + row.amount, 0);
    const near = (value: number) => Math.abs(value - week.amount) < 1;
    const rowSet = near(sum(all))
      ? 'all'
      : near(sum(checkedRows))
        ? 'checked'
        : 'none';
    const rows = rowSet === 'checked' ? checkedRows : all;

    const request = await db.approvalRequest.findUnique({
      where: { instanceCode: week.instanceCode },
      select: {
        id: true,
        completedAt: true,
        weeklyBatch: { select: { id: true, code: true, status: true } },
      },
    });
    const posted = request
      ? await db.internalFundTransaction.aggregate({
          where: {
            approvalRequestId: request.id,
            status: 'POSTED',
            transactionType: 'EXPENSE',
          },
          _sum: { amount: true },
        })
      : null;

    const byRecord = new Map(
      (
        await db.internalFinanceEntry.findMany({
          where: {
            sourceKey: { in: rows.map((row) => prefix + row.recordId) },
          },
          select: entrySelect,
        })
      ).map((entry) => [entry.sourceKey!.slice(prefix.length), entry]),
    );
    const days = rows.map((row) => row.day).filter(Boolean) as string[];
    const vehicles = days.length
      ? await db.internalFinanceEntry.findMany({
          where: {
            branchId: input.branchId,
            direction: 'EXPENSE',
            sourceType: 'LARK_IMPORT',
            category: { in: ['FUEL', 'VEHICLE_CARE'] },
            status: { not: 'CANCELLED' },
            occurredAt: {
              gte: new Date(`${days.sort()[0]}T00:00:00+07:00`),
              lt: new Date(
                new Date(
                  `${days.sort()[days.length - 1]}T00:00:00+07:00`,
                ).getTime() + 86_400_000,
              ),
            },
          },
          select: entrySelect,
        })
      : [];

    const lines: WeekLine[] = [];
    for (const lark of rows) {
      let entry: WeekEntry | null = byRecord.get(lark.recordId) || null;
      let via: WeekLine['via'] = entry ? 'record' : null;
      // Bản sao đã gộp bằng dedupe:lark-twins: theo mã phiếu xe giữ lại.
      if (entry?.status === 'CANCELLED') {
        const code = /Trùng với phiếu (?:xe|báo đơn) (\S+)/.exec(
          entry.cancelReason || '',
        )?.[1];
        const kept = code
          ? await db.internalFinanceEntry.findUnique({
              where: { code },
              select: entrySelect,
            })
          : null;
        if (kept) {
          entry = kept;
          via = 'merged';
        }
      }
      if (!entry) {
        entry = matchVehicle(lark, vehicles, used);
        via = entry ? 'vehicle' : null;
      }
      if (entry) used.add(entry.id);
      let status: RowStatus;
      if (!entry) status = 'notFound';
      else if (entry.status === 'CANCELLED') status = 'cancelled';
      else if (entry.cashIssued) status = 'issued';
      else if (
        entry.cashFlowId ||
        entry.fundTransaction?.status === 'POSTED' ||
        (entry.weeklyBatchId &&
          entry.weeklyBatchId !== request?.weeklyBatch?.id)
      )
        status = 'otherBatch';
      else status = 'toFix';
      lines.push({
        lark,
        entry,
        via,
        status,
        ledgerRecorded: entry ? ledgerRecorded(entry) : false,
      });
    }
    plans.push({
      week: week.week,
      year: input.year,
      larkAmount: week.amount,
      instanceCode: week.instanceCode,
      request: request
        ? { id: request.id, completedAt: request.completedAt }
        : null,
      batch: request?.weeklyBatch ?? null,
      larkAllRows: sum(all),
      larkCheckedRows: sum(checkedRows),
      rowSet,
      posPosted: Number(posted?._sum.amount || 0),
      lines,
    });
  }
  return plans;
}

/** Tiền sẽ trừ thêm vào quỹ khi sửa (phiếu đã trừ trên Lark thì không trừ). */
export const fixAmount = (plan: WeekPlan) =>
  plan.lines
    .filter((line) => line.status === 'toFix' && !line.ledgerRecorded)
    .reduce((sum, line) => sum + Number(line.entry!.amount), 0);

export async function applyApprovedWeeks(
  prisma: PrismaClient,
  input: Parameters<typeof planApprovedWeeks>[1],
  userId: number,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${input.branchId}::integer)`;
      const plans = await planApprovedWeeks(tx, input);
      for (const plan of plans) {
        // Chỉ sửa tuần mà tập dòng Lark khớp đúng số tiền Approval.
        if (!plan.request?.completedAt || !plan.batch || plan.rowSet === 'none')
          continue;
        const issuedAt = plan.request.completedAt;
        let touched = false;
        for (const line of plan.lines) {
          if (line.status !== 'toFix' || !line.entry) continue;
          const entry = line.entry;
          await tx.internalFinanceEntry.update({
            where: { id: entry.id },
            data: {
              managerReviewedAt: entry.managerReviewedAt ?? issuedAt,
              accountantReviewedAt: entry.accountantReviewedAt ?? issuedAt,
              weeklyBatchId: plan.batch.id,
              status: 'APPROVED',
              cashIssued: true,
              cashIssuedAt: issuedAt,
              cashIssuedBy: userId,
              cashIssuedReason: line.ledgerRecorded
                ? 'Đã trừ quỹ trên Lark'
                : 'Lark đã duyệt tuần (đối chiếu Lark)',
              posManagedAt: new Date(),
            },
          });
          if (line.ledgerRecorded) continue;
          const sourceKey = `EXPENSE:${entry.id}`;
          const taken = await tx.internalFundTransaction.findUnique({
            where: { sourceKey },
            select: { id: true },
          });
          await tx.internalFundTransaction.create({
            data: {
              code: `QF-CHI-${randomUUID()}`,
              sourceKey: taken ? `${sourceKey}:${randomUUID()}` : sourceKey,
              branchId: entry.branchId,
              entryId: entry.id,
              transactionType: 'EXPENSE',
              amount: entry.amount,
              occurredAt: issuedAt,
              description: entry.description || entry.code,
              sourceType: 'INTERNAL_FINANCE_ENTRY',
              sourceId: String(entry.id),
              approvalRequestId: plan.request.id,
              status: 'POSTED',
              createdBy: userId,
            },
          });
          touched = true;
        }
        if (touched)
          await tx.internalFundDailyClosing.updateMany({
            where: {
              branchId: input.branchId,
              closingDate: { gte: fundClosingDate(issuedAt) },
              closedAt: { not: null },
            },
            data: { reconciliationStatus: 'PENDING' },
          });
      }
      return plans;
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
}
