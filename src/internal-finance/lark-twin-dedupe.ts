import { Prisma, PrismaClient } from '@prisma/client';
import { fundClosingDate } from '../internal-fund/internal-fund-ledger.service';
import { BRANCHES, fundBalance, readText } from './legacy-fund-reconcile';

/**
 * Gộp một lần các phiếu chi bị nhập đôi từ LarkBase.
 *
 * Trên Lark, mỗi phiếu ở bảng xe (Xăng dầu / Chăm sóc xe) và mỗi cước báo đơn
 * được tự sinh thêm một dòng ở bảng "Tổng hợp phiếu chi kho HN/SG". Lúc đồng bộ
 * POS nhập cả hai, nên cùng một khoản chi có hai dòng. Giữ phiếu xe / phiếu
 * báo đơn (K), chuyển sang nó trạng thái của bản sao (D): tick đồng kiểm, tuần
 * Approval, Đã chi + giao dịch quỹ, chứng từ, ghi chú; rồi hủy D kèm lý do.
 * Cặp không chắc chắn (khớp nhiều, khác tuần, khác số tiền) chỉ báo cáo.
 */
type Db = PrismaClient | Prisma.TransactionClient;

const EXPENSE_TABLE_SOURCES = ['EXPENSE_HN', 'EXPENSE_SG'];
const VEHICLE_CATEGORIES = ['FUEL', 'VEHICLE_CARE'];
const SLIP_FIELDS = ['Mã Báo Đơn', 'Mã báo đơn'];
const NOTE_FIELDS = ['GHI CHÚ', 'Ghi chú', 'Ghi Chú'];

export const TWIN_REASON = {
  vehicle: (code: string) =>
    `Trùng với phiếu xe ${code} (dữ liệu chuyển từ Lark)`,
  packing: (code: string) =>
    `Trùng với phiếu báo đơn ${code} (dữ liệu chuyển từ Lark)`,
};

export const normalizeText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Ngày theo giờ Việt Nam (yyyy-mm-dd). */
export const vnDay = (date: Date) =>
  new Date(date.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

const snapshotOf = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const fieldText = (fields: Record<string, unknown>, names: string[]) => {
  for (const name of names) {
    const text = readText(fields[name]).trim();
    if (text) return text;
  }
  return '';
};

/** Chữ của bản sao có thể chứa tên xe: nội dung, ghi chú, cột liên kết (HN). */
export function twinText(entry: {
  description: string | null;
  note: string | null;
  sourceSnapshot: unknown;
}) {
  const fields = snapshotOf(snapshotOf(entry.sourceSnapshot).fields);
  const links = Object.entries(fields)
    .filter(([name]) => normalizeText(name).includes('lien ket'))
    .map(([, value]) => readText(value));
  return normalizeText(
    [entry.description, entry.note, fieldText(fields, NOTE_FIELDS), ...links]
      .filter(Boolean)
      .join(' | '),
  );
}

export function slipCodeOf(entry: { sourceSnapshot: unknown }) {
  return fieldText(
    snapshotOf(snapshotOf(entry.sourceSnapshot).fields),
    SLIP_FIELDS,
  );
}

export interface TwinEntry {
  id: number;
  code: string;
  branchId: number;
  amount: Prisma.Decimal | number | string;
  occurredAt: Date;
  description: string | null;
  note: string | null;
  sourceSnapshot: unknown;
  vehicleName?: string | null;
  vehicle?: { label: string } | null;
  packingSlipId?: number | null;
  category?: string | null;
  subCategory?: string | null;
  sourceKey?: string | null;
}

export interface TwinPair<T> {
  kind: 'vehicle' | 'packing';
  dup: T;
  keep: T;
}

const vehicleLabel = (entry: TwinEntry) =>
  entry.vehicle?.label ||
  entry.vehicleName ||
  readText(snapshotOf(entry.sourceSnapshot).vehicle);

/** Loại dịch vụ của phiếu chăm sóc xe ("Sửa chữa, Thay nhớt - <xe>" → 2 loại). */
function careServices(keep: TwinEntry) {
  const fromSnapshot = readText(snapshotOf(keep.sourceSnapshot).serviceType);
  const label = vehicleLabel(keep);
  const fromDescription = (keep.description || '')
    .replace(` - ${label}`, '')
    .trim();
  return (fromSnapshot || fromDescription)
    .split(',')
    .map((service) => normalizeText(service))
    .filter(Boolean);
}

/**
 * Cùng xe, cùng ngày, cùng số tiền có cả phiếu xăng lẫn phiếu chăm sóc xe:
 * bản sao ghi tên dịch vụ ("Phạt nóng"…) là phiếu chăm sóc xe đó, không ghi
 * dịch vụ nào là phiếu xăng.
 */
function narrowByService<T extends TwinEntry>(text: string, found: T[]) {
  if (found.length < 2) return found;
  const care = found.filter(
    (keep) =>
      keep.category === 'VEHICLE_CARE' &&
      careServices(keep).some((service) => text.includes(service)),
  );
  if (care.length) return care;
  const fuel = found.filter((keep) => keep.category === 'FUEL');
  return fuel.length ? fuel : found;
}

/**
 * Ghép bản sao ở bảng phiếu chi với phiếu xe: cùng kho, cùng ngày (giờ VN),
 * cùng số tiền và tên xe nằm trong chữ của bản sao. Chỉ nhận cặp 1–1.
 */
export function matchVehicleTwins<T extends TwinEntry>(dups: T[], keeps: T[]) {
  const byKey = new Map<string, T[]>();
  for (const keep of keeps) {
    const label = normalizeText(vehicleLabel(keep));
    if (!label) continue;
    const key = `${keep.branchId}|${vnDay(keep.occurredAt)}|${Number(keep.amount)}`;
    byKey.set(key, [...(byKey.get(key) || []), keep]);
  }
  const candidates = new Map<number, T[]>();
  const claimedBy = new Map<number, number>();
  for (const dup of dups) {
    const key = `${dup.branchId}|${vnDay(dup.occurredAt)}|${Number(dup.amount)}`;
    const text = twinText(dup);
    const found = narrowByService(
      text,
      (byKey.get(key) || []).filter((keep) =>
        text.includes(normalizeText(vehicleLabel(keep))),
      ),
    );
    if (!found.length) continue;
    candidates.set(dup.id, found);
    for (const keep of found)
      claimedBy.set(keep.id, (claimedBy.get(keep.id) || 0) + 1);
  }
  const pairs: TwinPair<T>[] = [];
  const ambiguous: Array<{ dup: T; keeps: T[] }> = [];
  for (const dup of dups) {
    const found = candidates.get(dup.id);
    if (!found) continue;
    if (found.length === 1 && claimedBy.get(found[0].id) === 1)
      pairs.push({ kind: 'vehicle', dup, keep: found[0] });
    else ambiguous.push({ dup, keeps: found });
  }
  return { pairs, ambiguous };
}

/**
 * Ghép bản sao có "Mã Báo Đơn" với phiếu chi POS tự sinh từ báo đơn đó
 * (`PACKING_SLIP:<id>:<loại phí>`). Khác số tiền thì chỉ báo cáo.
 */
export function matchPackingTwins<T extends TwinEntry>(
  dups: T[],
  keepsByKey: Map<string, T>,
  slipIdByCode: Map<string, number>,
) {
  const pairs: TwinPair<T>[] = [];
  const mismatched: Array<{ dup: T; keep: T }> = [];
  const used = new Set<number>();
  for (const dup of dups) {
    const slipId =
      dup.packingSlipId || slipIdByCode.get(slipCodeOf(dup)) || null;
    if (!slipId || !dup.subCategory) continue;
    const keep = keepsByKey.get(`PACKING_SLIP:${slipId}:${dup.subCategory}`);
    if (!keep || used.has(keep.id)) continue;
    used.add(keep.id);
    if (Number(keep.amount) === Number(dup.amount))
      pairs.push({ kind: 'packing', dup, keep });
    else mismatched.push({ dup, keep });
  }
  return { pairs, mismatched };
}

const entrySelect = {
  id: true,
  code: true,
  branchId: true,
  amount: true,
  occurredAt: true,
  description: true,
  note: true,
  status: true,
  sourceType: true,
  sourceKey: true,
  sourceSnapshot: true,
  category: true,
  subCategory: true,
  vehicleName: true,
  vehicle: { select: { label: true } },
  packingSlipId: true,
  payerId: true,
  weeklyBatchId: true,
  weeklyBatch: { select: { id: true, code: true, status: true } },
  managerReviewedAt: true,
  managerReviewedBy: true,
  accountantReviewedAt: true,
  accountantReviewedBy: true,
  cashIssued: true,
  cashIssuedAt: true,
  cashIssuedBy: true,
  cashIssuedReason: true,
  cashFlowId: true,
  fundTransaction: {
    select: {
      id: true,
      code: true,
      status: true,
      sourceKey: true,
      amount: true,
      occurredAt: true,
    },
  },
  attachments: {
    select: {
      kind: true,
      fileUrl: true,
      fileName: true,
      fileType: true,
      fileSize: true,
      createdBy: true,
    },
  },
} satisfies Prisma.InternalFinanceEntrySelect;

export type TwinRow = Prisma.InternalFinanceEntryGetPayload<{
  select: typeof entrySelect;
}>;

export type MergeAction =
  | 'moveBatch'
  | 'detachSameBatch'
  | 'moveCash'
  | 'cancelDoubleFund';

export interface PlannedMerge {
  kind: 'vehicle' | 'packing';
  dup: TwinRow;
  keep: TwinRow;
  actions: MergeAction[];
}

const postedTx = (row: TwinRow) =>
  row.fundTransaction?.status === 'POSTED' ? row.fundTransaction : null;

/** Việc cần làm cho một cặp; null khi không tự gộp được (ghi lý do). */
export function planMerge(
  dup: TwinRow,
  keep: TwinRow,
): { actions: MergeAction[] } | { skip: string } {
  if (dup.cashFlowId || keep.cashFlowId)
    return { skip: 'Có phiếu sổ quỹ cửa hàng' };
  const actions: MergeAction[] = [];
  if (dup.weeklyBatchId) {
    if (!keep.weeklyBatchId) actions.push('moveBatch');
    else if (keep.weeklyBatchId === dup.weeklyBatchId)
      actions.push('detachSameBatch');
    else
      return {
        skip: `Mỗi dòng ở một tuần (${dup.weeklyBatch?.code} / ${keep.weeklyBatch?.code})`,
      };
  }
  if (dup.cashIssued) {
    const dupTx = postedTx(dup);
    const keepTx = postedTx(keep);
    if (!keep.cashIssued || (dupTx && !keepTx)) actions.push('moveCash');
    else if (dupTx && keepTx) actions.push('cancelDoubleFund');
  }
  return { actions };
}

export async function planTwinDedupe(db: Db) {
  const dups = (
    await db.internalFinanceEntry.findMany({
      where: {
        branchId: { in: BRANCHES },
        direction: 'EXPENSE',
        sourceType: 'LARK_IMPORT',
        status: { not: 'CANCELLED' },
      },
      select: entrySelect,
    })
  ).filter((row) =>
    EXPENSE_TABLE_SOURCES.includes(
      String(snapshotOf(snapshotOf(row.sourceSnapshot).lark).source || ''),
    ),
  );
  const vehicleKeeps = await db.internalFinanceEntry.findMany({
    where: {
      branchId: { in: BRANCHES },
      direction: 'EXPENSE',
      sourceType: 'LARK_IMPORT',
      category: { in: VEHICLE_CATEGORIES },
      status: { not: 'CANCELLED' },
    },
    select: entrySelect,
  });
  const vehicle = matchVehicleTwins(
    dups.filter((row) => !VEHICLE_CATEGORIES.includes(row.category)),
    vehicleKeeps,
  );

  const vehicleDupIds = new Set([
    ...vehicle.pairs.map((pair) => pair.dup.id),
    ...vehicle.ambiguous.map((item) => item.dup.id),
  ]);
  const packingDups = dups.filter(
    (row) =>
      !vehicleDupIds.has(row.id) &&
      (row.packingSlipId || slipCodeOf(row)) &&
      row.subCategory,
  );
  const codes = [
    ...new Set(packingDups.map(slipCodeOf).filter((code) => code)),
  ];
  const slips = codes.length
    ? await db.packingSlip.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true },
      })
    : [];
  const slipIdByCode = new Map(
    slips.filter((slip) => slip.code).map((slip) => [slip.code!, slip.id]),
  );
  const slipIds = [
    ...new Set([
      ...slips.map((slip) => slip.id),
      ...packingDups
        .map((row) => row.packingSlipId)
        .filter((id): id is number => Boolean(id)),
    ]),
  ];
  const packingKeeps = slipIds.length
    ? await db.internalFinanceEntry.findMany({
        where: {
          packingSlipId: { in: slipIds },
          sourceType: 'PACKING_SLIP',
          direction: 'EXPENSE',
          status: { not: 'CANCELLED' },
        },
        select: entrySelect,
      })
    : [];
  const packing = matchPackingTwins(
    packingDups,
    new Map(
      packingKeeps
        .filter((row) => row.sourceKey)
        .map((row) => [row.sourceKey!, row]),
    ),
    slipIdByCode,
  );

  const merges: PlannedMerge[] = [];
  const skipped: Array<{ dup: TwinRow; keep: TwinRow; reason: string }> = [];
  for (const pair of [...vehicle.pairs, ...packing.pairs]) {
    const result = planMerge(pair.dup, pair.keep);
    if ('skip' in result)
      skipped.push({ dup: pair.dup, keep: pair.keep, reason: result.skip });
    else merges.push({ ...pair, actions: result.actions });
  }
  return {
    merges,
    skipped,
    ambiguous: vehicle.ambiguous,
    packingMismatched: packing.mismatched,
  };
}

export type TwinPlan = Awaited<ReturnType<typeof planTwinDedupe>>;

/** Quỹ được cộng lại khi hủy giao dịch trừ quỹ lần hai của bản sao. */
export function refundByBranch(plan: TwinPlan) {
  const refund = new Map(BRANCHES.map((id) => [id, 0]));
  for (const merge of plan.merges)
    if (merge.actions.includes('cancelDoubleFund'))
      refund.set(
        merge.dup.branchId,
        refund.get(merge.dup.branchId)! +
          Number(merge.dup.fundTransaction!.amount),
      );
  return refund;
}

export { fundBalance };

export async function applyTwinDedupe(prisma: PrismaClient, userId: number) {
  return prisma.$transaction(
    async (tx) => {
      for (const id of [...BRANCHES].sort((a, b) => a - b))
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${id}::integer)`;
      const plan = await planTwinDedupe(tx);
      const now = new Date();
      const closingFrom = new Map<number, Date>();

      for (const { kind, dup, keep, actions } of plan.merges) {
        const keepData: Prisma.InternalFinanceEntryUncheckedUpdateInput = {
          posManagedAt: now,
        };
        // Tick đồng kiểm: phiếu giữ lại chưa có thì lấy của bản sao.
        if (!keep.managerReviewedAt && dup.managerReviewedAt) {
          keepData.managerReviewedAt = dup.managerReviewedAt;
          keepData.managerReviewedBy = dup.managerReviewedBy;
        }
        if (!keep.accountantReviewedAt && dup.accountantReviewedAt) {
          keepData.accountantReviewedAt = dup.accountantReviewedAt;
          keepData.accountantReviewedBy = dup.accountantReviewedBy;
        }
        if (!keep.payerId && dup.payerId) keepData.payerId = dup.payerId;

        if (actions.includes('moveBatch')) {
          keepData.weeklyBatchId = dup.weeklyBatchId;
          keepData.status = dup.status;
        } else if (
          !keep.weeklyBatchId &&
          (keepData.managerReviewedAt || keep.managerReviewedAt) &&
          (keepData.accountantReviewedAt || keep.accountantReviewedAt) &&
          [
            'PENDING_ACCOUNTANT',
            'ACCOUNTANT_APPROVED',
            'PENDING_MANAGER',
          ].includes(keep.status)
        ) {
          // Đủ hai tick sau khi gộp thì sẵn sàng gom tuần như luồng tick.
          keepData.status = 'MANAGER_APPROVED';
        }
        if (
          actions.includes('detachSameBatch') &&
          dup.weeklyBatch?.status === 'READY'
        ) {
          await tx.internalFinanceWeeklyBatch.update({
            where: { id: dup.weeklyBatchId! },
            data: { totalAmount: { decrement: dup.amount } },
          });
        }

        const dupSnapshot = snapshotOf(dup.sourceSnapshot);
        if (actions.includes('moveCash')) {
          keepData.cashIssued = true;
          keepData.cashIssuedAt = dup.cashIssuedAt;
          keepData.cashIssuedBy = dup.cashIssuedBy;
          keepData.cashIssuedReason = dup.cashIssuedReason;
          if (dupSnapshot.larkLedgerRecorded === true)
            keepData.sourceSnapshot = {
              ...snapshotOf(keep.sourceSnapshot),
              larkLedgerRecorded: true,
            };
          const dupTx = postedTx(dup);
          if (dupTx && !postedTx(keep)) {
            const nextKey = `EXPENSE:${keep.id}`;
            const taken = await tx.internalFundTransaction.findUnique({
              where: { sourceKey: nextKey },
              select: { id: true },
            });
            await tx.internalFundTransaction.update({
              where: { id: dupTx.id },
              data: {
                entryId: keep.id,
                ...(taken ? {} : { sourceKey: nextKey }),
              },
            });
          }
        }
        if (actions.includes('cancelDoubleFund')) {
          const dupTx = postedTx(dup)!;
          await tx.internalFundTransaction.update({
            where: { id: dupTx.id },
            data: {
              status: 'CANCELLED',
              cancelledAt: now,
              cancelledBy: userId,
              cancelReason: TWIN_REASON[kind](keep.code),
              entryId: null,
              sourceKey: `${dupTx.sourceKey}:CANCELLED:${dupTx.id}`,
            },
          });
          const from = closingFrom.get(dup.branchId);
          if (!from || dupTx.occurredAt < from)
            closingFrom.set(dup.branchId, dupTx.occurredAt);
        }
        await tx.internalFinanceEntry.update({
          where: { id: keep.id },
          data: keepData,
        });

        // Chứng từ của bản sao chưa có ở phiếu giữ lại.
        const known = new Set(keep.attachments.map((file) => file.fileUrl));
        const extra = dup.attachments.filter(
          (file) => file.fileUrl && !known.has(file.fileUrl),
        );
        if (extra.length)
          await tx.internalFinanceAttachment.createMany({
            data: extra.map((file) => ({ ...file, entryId: keep.id })),
          });
        await tx.internalFinanceEntryNote.updateMany({
          where: { entryId: dup.id },
          data: { entryId: keep.id },
        });

        const reason = TWIN_REASON[kind](keep.code);
        await tx.internalFinanceReview.create({
          data: {
            entryId: dup.id,
            role: 'MANAGER',
            decision: 'CANCEL',
            reason,
            reviewerId: userId,
          },
        });
        await tx.internalFinanceEntry.update({
          where: { id: dup.id },
          data: {
            status: 'CANCELLED',
            cancelReason: reason,
            cancelledAt: now,
            cancelledBy: userId,
            posManagedAt: now,
            weeklyBatchId: null,
            cashIssued: false,
            cashIssuedAt: null,
            cashIssuedBy: null,
            cashIssuedReason: null,
          },
        });
      }

      for (const [branchId, date] of closingFrom)
        await tx.internalFundDailyClosing.updateMany({
          where: {
            branchId,
            closingDate: { gte: fundClosingDate(date) },
            closedAt: { not: null },
          },
          data: { reconciliationStatus: 'PENDING' },
        });
      return plan;
    },
    { timeout: 600_000, maxWait: 60_000 },
  );
}
