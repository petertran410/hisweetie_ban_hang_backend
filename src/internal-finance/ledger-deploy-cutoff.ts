import { Prisma, PrismaClient } from '@prisma/client';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import { CUTOFF } from './legacy-fund-reconcile';

/**
 * Hệ thống tài chính nội bộ chạy từ 14/10/2026. Tới hết 13/10 kho ghi tiền
 * ngay vào sổ quỹ Lark Base ("Giao Dịch Tiền Mặt - Kho"), từ 14/10 quỹ đi theo
 * luồng POS. Sổ Lark Base đã chép vào Quỹ nội bộ (LEDGER_HISTORY) cả vài ngày
 * sau mốc đối soát 11/10, nên:
 *  - dòng sổ Lark 11–13/10 giữ nguyên; phiếu POS trùng với chúng được gắn dấu
 *    "đã ghi quỹ trên Lark" để duyệt tuần / lập phiếu thu không ghi quỹ lần 2;
 *  - dòng sổ Lark từ 14/10 bị hủy, phiếu POS tương ứng tự ghi quỹ.
 */
export const DEPLOY_CUTOFF = new Date('2026-10-14T00:00:00+07:00');
export const KHO_IDS = [6, 1];
export const VOID_REASON = 'Từ 14/10 quỹ ghi theo POS';
export const LEDGER_MARK_REASON = 'Đã ghi trên sổ quỹ Lark (trước 14/10)';

const DAY = 86400000;

export interface LedgerRow {
  id: number;
  code: string;
  branchId: number;
  transactionType: string;
  amount: Prisma.Decimal | number;
  occurredAt: Date;
  description: string | null;
}

export interface PosEntry {
  id: number;
  code: string;
  branchId: number;
  direction: string;
  category: string;
  subCategory: string | null;
  sourceType: string;
  amount: Prisma.Decimal | number;
  occurredAt: Date;
  description: string | null;
  status: string;
  cashIssued: boolean;
  sourceSnapshot: Prisma.JsonValue | null;
  invoiceCodes: string[];
  plate: string | null;
  customerName: string | null;
  fundPosted: boolean;
  batch: string | null;
}

export type MatchKind = 'HD' | 'BIEN_SO' | 'TEN_KHACH' | 'SO_TIEN';

export interface LedgerMatch {
  ledger: LedgerRow;
  pos: PosEntry | null;
  by: MatchKind | null;
}

const num = (value: Prisma.Decimal | number) => Number(value);
const incoming = (type: string) => ['RECEIPT', 'TRANSFER_IN'].includes(type);

export function normalizeText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** Mã hóa đơn "HD131271", "HD131273.01" trong nội dung dòng sổ. */
export function invoiceCodesIn(text: string | null | undefined) {
  return [...String(text || '').matchAll(/HD\d+(?:\.\d+)?/gi)].map((m) =>
    m[0].toUpperCase(),
  );
}

/** Biển số chỉ giữ chữ và số: "29D - 132.16" → "29d13216". */
export function plateKey(value: string | null | undefined) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function ledgerKind(row: LedgerRow) {
  const text = normalizeText(row.description);
  if (incoming(row.transactionType)) return 'RECEIPT';
  if (/^(phi gui ben|phi grab|cuoc)/.test(text)) return 'DELIVERY';
  if (/xang|dau xe|sua chua|cham soc|bom xe/.test(text)) return 'VEHICLE';
  return 'OTHER';
}

/** Loại phí báo đơn theo đầu nội dung dòng sổ Lark. */
function feeTypeOf(text: string | null | undefined) {
  const value = normalizeText(text);
  if (value.startsWith('phi gui ben')) return 'FEE_GUI_BEN';
  if (value.startsWith('phi grab')) return 'FEE_GRAB';
  if (value.startsWith('cuoc gui')) return 'SHIPPING_OUT';
  if (value.startsWith('cuoc nhan')) return 'SHIPPING_IN';
  return null;
}

/** Tên khách trong "Thu tiền của <tên> (Sale …)". */
function customerIn(text: string | null | undefined) {
  const match = normalizeText(text).match(/thu tien cua (.+?)(?: \(|$)/);
  return match ? match[1].trim() : '';
}

/**
 * Ghép dòng sổ Lark với phiếu POS cùng kho, cùng chiều, cùng số tiền; mỗi
 * phiếu POS chỉ ghép một lần. Phí báo đơn ghép theo mã hóa đơn, phiếu xe theo
 * biển số, phiếu thu ưu tiên tên khách.
 */
export function matchLedgerRows(
  ledgerRows: LedgerRow[],
  entries: PosEntry[],
): LedgerMatch[] {
  const used = new Set<number>();
  // Dòng có căn cứ chặt (mã HD, biển số) ghép trước.
  const order = [...ledgerRows].sort((a, b) => {
    const rank = (row: LedgerRow) =>
      ledgerKind(row) === 'DELIVERY'
        ? 0
        : ledgerKind(row) === 'VEHICLE'
          ? 1
          : 2;
    return rank(a) - rank(b) || a.id - b.id;
  });
  const result = new Map<number, LedgerMatch>();
  for (const ledger of order) {
    const kind = ledgerKind(ledger);
    const direction = incoming(ledger.transactionType) ? 'RECEIPT' : 'EXPENSE';
    const near = (entry: PosEntry, days: number) =>
      entry.occurredAt.getTime() >= ledger.occurredAt.getTime() - days * DAY &&
      entry.occurredAt.getTime() <= ledger.occurredAt.getTime() + days * DAY;
    const pool = entries.filter(
      (entry) =>
        !used.has(entry.id) &&
        entry.branchId === ledger.branchId &&
        entry.direction === direction &&
        num(entry.amount) === num(ledger.amount),
    );
    let pos: PosEntry | null = null;
    let by: MatchKind | null = null;
    if (kind === 'DELIVERY') {
      // Báo đơn có thể nhập trên POS sau ngày chi và khác số tiền: ghép theo mã
      // hóa đơn + loại phí, ưu tiên cùng số tiền.
      const codes = invoiceCodesIn(ledger.description);
      const fee = feeTypeOf(ledger.description);
      const byInvoice = entries.filter(
        (entry) =>
          !used.has(entry.id) &&
          entry.branchId === ledger.branchId &&
          entry.direction === 'EXPENSE' &&
          entry.sourceType === 'PACKING_SLIP' &&
          (!fee || entry.subCategory === fee) &&
          entry.invoiceCodes.some((code) => codes.includes(code)),
      );
      pos =
        byInvoice.find((entry) => num(entry.amount) === num(ledger.amount)) ||
        byInvoice[0] ||
        null;
      if (pos) by = 'HD';
    } else if (kind === 'VEHICLE') {
      const text = plateKey(ledger.description);
      pos =
        pool.find(
          (entry) =>
            Boolean(entry.plate) &&
            text.includes(plateKey(entry.plate)) &&
            near(entry, 1),
        ) || null;
      if (pos) by = 'BIEN_SO';
    } else if (kind === 'RECEIPT') {
      const name = customerIn(ledger.description);
      const candidates = pool.filter((entry) => near(entry, 3));
      pos =
        (name &&
          candidates.find((entry) => {
            const customer = normalizeText(entry.customerName);
            return (
              Boolean(customer) &&
              (name.includes(customer) || customer.includes(name))
            );
          })) ||
        null;
      if (pos) by = 'TEN_KHACH';
      else if (candidates.length === 1) {
        pos = candidates[0];
        by = 'SO_TIEN';
      }
    } else {
      const candidates = pool.filter((entry) => near(entry, 1));
      if (candidates.length === 1) {
        pos = candidates[0];
        by = 'SO_TIEN';
      }
    }
    if (pos) used.add(pos.id);
    result.set(ledger.id, { ledger, pos, by });
  }
  return ledgerRows.map((row) => result.get(row.id)!);
}

/** Phiếu POS đã ghi quỹ hoặc đã có dấu: không gắn dấu nữa. */
export function canMark(entry: PosEntry) {
  if (entry.status === 'CANCELLED' || entry.fundPosted) return false;
  if (entry.direction === 'EXPENSE' && entry.cashIssued) return false;
  if (entry.direction === 'RECEIPT' && entry.status === 'POSTED') return false;
  const snapshot = entry.sourceSnapshot as { larkLedgerRecorded?: unknown };
  return snapshot?.larkLedgerRecorded !== true;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadLedgerDeploy(db: Db) {
  const ledgerRows = await db.internalFundTransaction.findMany({
    where: {
      branchId: { in: KHO_IDS },
      sourceType: 'LEDGER_HISTORY',
      status: 'POSTED',
      occurredAt: { gte: CUTOFF },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      code: true,
      branchId: true,
      transactionType: true,
      amount: true,
      occurredAt: true,
      description: true,
    },
  });
  const keep = ledgerRows.filter((row) => row.occurredAt < DEPLOY_CUTOFF);
  const afterDeploy = ledgerRows.filter(
    (row) => row.occurredAt >= DEPLOY_CUTOFF,
  );
  // Phiếu POS từ 8/10 đến 16/10: báo đơn lưu trễ mang ngày lưu, không phải ngày chi.
  const hdCodes = [
    ...new Set(ledgerRows.flatMap((row) => invoiceCodesIn(row.description))),
  ];
  const raw = await db.internalFinanceEntry.findMany({
    where: {
      branchId: { in: KHO_IDS },
      status: { not: 'CANCELLED' },
      sourceType: { notIn: ['LARK_IMPORT', 'LARK_APPROVAL'] },
      OR: [
        {
          occurredAt: {
            gte: new Date(CUTOFF.getTime() - 3 * DAY),
            lt: new Date(DEPLOY_CUTOFF.getTime() + 3 * DAY),
          },
        },
        // Báo đơn nhập trễ cho hóa đơn có trên sổ Lark, ngày nào cũng lấy.
        ...(hdCodes.length
          ? [
              {
                sourceType: 'PACKING_SLIP',
                packingSlip: {
                  invoices: { some: { invoice: { code: { in: hdCodes } } } },
                },
              },
            ]
          : []),
      ],
    },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      code: true,
      branchId: true,
      direction: true,
      category: true,
      subCategory: true,
      sourceType: true,
      amount: true,
      occurredAt: true,
      description: true,
      status: true,
      cashIssued: true,
      sourceSnapshot: true,
      vehicleName: true,
      vehicle: { select: { plate: true } },
      customer: { select: { name: true } },
      fundTransaction: { select: { status: true } },
      weeklyBatch: { select: { code: true, status: true } },
      packingSlip: {
        select: {
          invoices: { select: { invoice: { select: { code: true } } } },
        },
      },
    },
  });
  const entries: PosEntry[] = raw.map((entry) => ({
    id: entry.id,
    code: entry.code,
    branchId: entry.branchId,
    direction: entry.direction,
    category: entry.category,
    subCategory: entry.subCategory,
    sourceType: entry.sourceType,
    amount: entry.amount,
    occurredAt: entry.occurredAt,
    description: entry.description,
    status: entry.status,
    cashIssued: entry.cashIssued,
    sourceSnapshot: entry.sourceSnapshot,
    invoiceCodes: [
      ...(entry.packingSlip?.invoices || [])
        .map((link) => link.invoice?.code?.toUpperCase())
        .filter((code): code is string => Boolean(code)),
      ...invoiceCodesIn(entry.description),
    ],
    plate: entry.vehicle?.plate || entry.vehicleName || null,
    customerName: entry.customer?.name || null,
    fundPosted: entry.fundTransaction?.status === 'POSTED',
    batch: entry.weeklyBatch
      ? `${entry.weeklyBatch.code} (${entry.weeklyBatch.status})`
      : null,
  }));
  const matches = matchLedgerRows(keep, entries);
  const matchedIds = new Set(
    matches.map((item) => item.pos?.id).filter((id): id is number => !!id),
  );
  // Phiếu POS mang ngày trước 14/10 mà không trùng dòng sổ Lark nào: vẫn ghi quỹ
  // theo POS, người dùng cần xem có phải ghép sót không.
  const unmatchedPos = entries.filter(
    (entry) =>
      !matchedIds.has(entry.id) &&
      entry.occurredAt >= CUTOFF &&
      entry.occurredAt < DEPLOY_CUTOFF &&
      !entry.fundPosted &&
      !(entry.direction === 'EXPENSE' && entry.cashIssued) &&
      canMark(entry),
  );
  // Dòng sổ Lark từ 14/10: chỉ hủy dòng có phiếu POS ghi quỹ thay; dòng POS
  // chưa có phiếu thì giữ trên sổ để quỹ không thiếu tiền.
  const voidMatches = matchLedgerRows(
    afterDeploy,
    entries.filter((entry) => !matchedIds.has(entry.id)),
  );
  const voids = voidMatches
    .filter((item) => item.pos)
    .map((item) => item.ledger);
  return { keep, voids, matches, unmatchedPos, voidMatches };
}

/** Gắn dấu phiếu POS trùng sổ Lark và hủy dòng sổ Lark từ 14/10. */
export async function applyLedgerDeploy(prisma: PrismaClient, userId: number) {
  const ledger = new InternalFundLedgerService();
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, KHO_IDS);
      const plan = await loadLedgerDeploy(tx);
      let marked = 0;
      for (const { ledger: row, pos } of plan.matches) {
        if (!pos || !canMark(pos)) continue;
        const snapshot =
          pos.sourceSnapshot && typeof pos.sourceSnapshot === 'object'
            ? (pos.sourceSnapshot as Record<string, unknown>)
            : {};
        await tx.internalFinanceEntry.update({
          where: { id: pos.id },
          data: {
            sourceSnapshot: {
              ...snapshot,
              larkLedgerRecorded: true,
              larkLedgerCode: row.code,
            } as Prisma.InputJsonValue,
          },
        });
        marked += 1;
      }
      const now = new Date();
      for (const row of plan.voids) {
        await tx.internalFundTransaction.update({
          where: { id: row.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelledBy: userId,
            cancelReason: VOID_REASON,
          },
        });
        await ledger.invalidateClosings(tx, row.branchId, row.occurredAt);
      }
      return { ...plan, marked, voided: plan.voids.length };
    },
    { timeout: 60000 },
  );
}

export async function fundBalances(db: Db) {
  const groups = await db.internalFundTransaction.groupBy({
    by: ['branchId', 'transactionType'],
    where: { branchId: { in: KHO_IDS }, status: 'POSTED' },
    _sum: { amount: true },
  });
  const balance: Record<number, number> = { 6: 0, 1: 0 };
  for (const group of groups)
    balance[group.branchId] +=
      (incoming(group.transactionType) ? 1 : -1) *
      Number(group._sum.amount || 0);
  return balance;
}
