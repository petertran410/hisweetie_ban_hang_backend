import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { VPHN_LEDGER_CUTOFF } from '../approval-lifecycle/approval-lifecycle.constants';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import {
  LEDGER_PREFIX,
  REASON,
  VPHN,
  ledgerBranch,
  mapLedgerRecord,
  readText,
  type LarkRecord,
  type LedgerTx,
} from './legacy-fund-reconcile';

/**
 * Văn phòng HN: sổ quỹ Lark Base ("Giao Dịch Tiền Mặt - Kho", chi nhánh
 * "Văn Phòng Hà Nội") là số đúng tới hết 31/10/2026; POS tự ghi quỹ từ 01/11.
 *
 * 1. Dòng sổ Lark trước mốc chưa có trên POS: thêm (LEDGER_HISTORY). Lần nhập
 *    đầu (đầu tháng 10) đã bỏ sót các dòng "Chuyển Tiền Nội Bộ" và dòng ghi
 *    sau ngày nhập.
 * 2. Dòng POS tự ghi theo đơn Lark trước mốc (PHIẾU CHI, PHIẾU THU, chuyển
 *    tiền về VPHN): hủy, vì dòng sổ Lark cùng khoản được thêm ở bước 1. Phiếu
 *    gắn với dòng bị hủy giữ "Đã chi" và mang dấu "đã trừ quỹ trên Lark".
 * Chạy lại được nhiều lần: chỉ thêm dòng còn thiếu, chỉ hủy dòng còn hiệu lực.
 */
export const VPHN_VOID_REASON = 'Thay bằng sổ quỹ Lark tới hết 31/10/2026';
const TWIN_SPAN = 36 * 3600000;

type Db = PrismaClient | Prisma.TransactionClient;

export interface PosFundRow {
  id: number;
  code: string;
  branchId: number;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  sourceKey: string;
  sourceType: string;
  status: string;
  description: string | null;
  entryId: number | null;
}

const fundSelect = {
  id: true,
  code: true,
  branchId: true,
  transactionType: true,
  amount: true,
  occurredAt: true,
  sourceKey: true,
  sourceType: true,
  status: true,
  description: true,
  entryId: true,
} as const;

const incoming = (type: string) => ['RECEIPT', 'TRANSFER_IN'].includes(type);
const signed = (type: string, amount: Prisma.Decimal | number | string) => {
  const value = new Prisma.Decimal(amount);
  return incoming(type) ? value : value.negated();
};
const sum = (rows: Array<{ transactionType: string; amount: unknown }>) =>
  rows.reduce(
    (total, row) =>
      total.plus(signed(row.transactionType, row.amount as Prisma.Decimal)),
    new Prisma.Decimal(0),
  );

export interface SkippedLarkRow {
  recordId: string;
  code: string;
  occurredAt: Date | null;
  description: string;
  amount: number;
  reason: string;
}

export interface VphnImportPlan {
  until: Date;
  /** Dòng sổ Lark sẽ thêm vào POS. */
  add: LedgerTx[];
  /** Dòng sổ Lark đã có trên POS (không đụng). */
  existing: LedgerTx[];
  /** Dòng sổ Lark không tính vào quỹ (Hủy, thiếu ngày, không có số tiền). */
  skipped: SkippedLarkRow[];
  /** Dòng POS tự ghi sẽ hủy, kèm dòng Lark cùng khoản (null: không tìm thấy). */
  voids: Array<{ pos: PosFundRow; twin: LedgerTx | null }>;
  /** Số dư sổ Lark tới mốc (chỉ dòng tính vào quỹ). */
  larkBalance: Prisma.Decimal;
  /** Số dư POS tới mốc trước và sau khi áp dụng. */
  posBefore: Prisma.Decimal;
  posAfter: Prisma.Decimal;
}

/** Mốc "hết ngày `to`" theo giờ Việt Nam; không có thì lấy mốc chuyển của VPHN. */
export function untilOf(to?: string) {
  if (!to) return VPHN_LEDGER_CUTOFF;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to))
    throw new Error('--to phải có dạng YYYY-MM-DD');
  return new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86400000);
}

export async function vphnFundBalance(db: Db, until?: Date) {
  const rows = await db.internalFundTransaction.groupBy({
    by: ['transactionType'],
    where: {
      branchId: VPHN,
      status: 'POSTED',
      ...(until ? { occurredAt: { lt: until } } : {}),
    },
    _sum: { amount: true },
  });
  return rows.reduce(
    (total, row) =>
      total.plus(signed(row.transactionType, row._sum.amount || 0)),
    new Prisma.Decimal(0),
  );
}

export async function planVphnImport(
  db: Db,
  records: LarkRecord[],
  until = VPHN_LEDGER_CUTOFF,
): Promise<VphnImportPlan> {
  const vphnRecords = records.filter(
    (record) => ledgerBranch(readText(record.fields['Chi Nhánh'])) === VPHN,
  );
  const skipped: SkippedLarkRow[] = [];
  const mapped: LedgerTx[] = [];
  for (const record of vphnRecords) {
    const rows = mapLedgerRecord(record, ledgerBranch);
    if (!rows.length) {
      skipped.push({
        recordId: record.recordId,
        code: readText(record.fields['Mã Phiếu']).trim(),
        occurredAt: record.createdAt ?? null,
        description: readText(record.fields['Nội Dung']).trim(),
        amount: 0,
        reason: 'Không có số tiền hoặc thiếu ngày',
      });
      continue;
    }
    for (const row of rows) {
      if (row.occurredAt >= until) continue;
      if (row.status !== 'POSTED') {
        skipped.push({
          recordId: record.recordId,
          code: row.code,
          occurredAt: row.occurredAt,
          description: row.description,
          amount: Number(row.amount),
          reason: row.cancelReason || 'Đã hủy trên Lark',
        });
        continue;
      }
      mapped.push(row);
    }
  }

  const posRows: PosFundRow[] = await db.internalFundTransaction.findMany({
    where: { branchId: VPHN, occurredAt: { lt: until } },
    select: fundSelect,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const posByKey = new Map(
    posRows
      .filter((row) => row.sourceKey.startsWith(LEDGER_PREFIX))
      .map((row) => [row.sourceKey, row]),
  );
  const add = mapped.filter((row) => !posByKey.has(row.sourceKey));
  const existing = mapped.filter((row) => posByKey.has(row.sourceKey));

  // Dòng POS tự ghi theo đơn Lark (quỹ, phiếu thu, chuyển tiền) trước mốc.
  const live = posRows.filter(
    (row) => row.status === 'POSTED' && row.sourceType !== 'LEDGER_HISTORY',
  );
  const taken = new Set<string>();
  const voids = live.map((pos) => {
    const twin =
      mapped.find(
        (lark) =>
          !taken.has(lark.sourceKey) &&
          incoming(lark.transactionType) === incoming(pos.transactionType) &&
          lark.amount.equals(pos.amount) &&
          Math.abs(lark.occurredAt.getTime() - pos.occurredAt.getTime()) <=
            TWIN_SPAN,
      ) || null;
    if (twin) taken.add(twin.sourceKey);
    return { pos, twin };
  });

  const posBefore = sum(posRows.filter((row) => row.status === 'POSTED'));
  const posAfter = posBefore
    .plus(sum(add))
    .minus(sum(voids.map((item) => item.pos)));
  return {
    until,
    add,
    existing,
    skipped,
    voids,
    larkBalance: sum(mapped),
    posBefore,
    posAfter,
  };
}

export async function applyVphnImport(
  prisma: PrismaClient,
  records: LarkRecord[],
  userId: number,
  until = VPHN_LEDGER_CUTOFF,
) {
  const ledger = new InternalFundLedgerService();
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [VPHN]);
      const plan = await planVphnImport(tx, records, until);

      // 2. Hủy dòng POS tự ghi trước; phiếu gắn với nó giữ Đã chi và mang dấu.
      for (const { pos } of plan.voids) {
        await ledger.releaseCancelled(tx, pos, userId, VPHN_VOID_REASON);
        if (pos.entryId)
          await tx.$executeRaw`
            UPDATE internal_finance_entries
            SET "sourceSnapshot" = COALESCE("sourceSnapshot", '{}'::jsonb)
                  || '{"larkLedgerRecorded": true}'::jsonb,
                "cashIssuedReason" = ${REASON.ledgerRecorded}
            WHERE id = ${pos.entryId}`;
      }

      // 1. Thêm dòng sổ Lark còn thiếu.
      const usedCodes = new Set(
        (
          await tx.internalFundTransaction.findMany({
            where: { code: { in: plan.add.map((row) => row.code) } },
            select: { code: true },
          })
        ).map((row) => row.code),
      );
      if (plan.add.length)
        await tx.internalFundTransaction.createMany({
          data: plan.add.map((row) => ({
            code: usedCodes.has(row.code) ? `QF-SQ-${randomUUID()}` : row.code,
            sourceKey: row.sourceKey,
            branchId: row.branchId,
            transactionType: row.transactionType,
            amount: row.amount,
            occurredAt: row.occurredAt,
            description: row.description,
            sourceType: 'LEDGER_HISTORY',
            status: 'POSTED',
            createdBy: userId,
            ...(row.createdAt ? { createdAt: row.createdAt } : {}),
            ...(row.modifiedAt ? { updatedAt: row.modifiedAt } : {}),
          })),
        });

      const touched = [
        ...plan.add.map((row) => row.occurredAt),
        ...plan.voids.map((item) => item.pos.occurredAt),
      ];
      if (touched.length)
        await ledger.invalidateClosings(
          tx,
          VPHN,
          new Date(Math.min(...touched.map((date) => date.getTime()))),
        );
      return plan;
    },
    { timeout: 600000, maxWait: 60000 },
  );
}
