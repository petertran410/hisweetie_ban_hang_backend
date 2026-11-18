import { Prisma, PrismaClient } from '@prisma/client';
import {
  PAYMENT_VOUCHER,
  larkLedgerCutoff,
  readPaymentVoucherDate,
  type ApprovalFormItem,
} from '../approval-lifecycle/approval-lifecycle.constants';
import {
  LARK_APPROVED_REASON,
  fundSourceKey,
  larkTime,
} from '../approval-lifecycle/lark-approval-mirror.service';
import {
  InternalFundLedgerService,
  LARK_LEDGER_RECORDED_REASON,
} from '../internal-fund/internal-fund-ledger.service';
import {
  INTERNAL_FINANCE_STATUS,
  LARK_APPROVAL_SOURCE_TYPE,
  VPSG_BRANCH_ID,
} from './internal-finance.constants';
import type { LarkRecord, LedgerTx } from './legacy-fund-reconcile';
import {
  applyLedgerPlan,
  assertApplyUntil,
  planLedgerImport,
} from './office-ledger-import';

/**
 * Quỹ VPSG trước mốc = sổ quỹ Lark Base + đơn PHIẾU CHI tiền mặt VPSG mà sổ
 * không ghi (người ghi sổ không theo kịp). Dòng sổ không liên kết đơn, nên đơn
 * và dòng sổ khớp nhau khi cùng số tiền và ngày sổ lệch tối đa `MATCH_DAYS` so
 * với ngày chi tiền / ngày duyệt / ngày gửi của đơn; ghép 1-1, cặp lệch ít
 * nhất trước.
 * - Khớp: giữ dòng sổ; đơn không có dòng quỹ riêng (đang có thì hủy), phiếu
 *   mang dấu "Đã trừ quỹ trên Lark".
 * - Không khớp: đơn ghi quỹ theo ngày duyệt, phiếu gắn với dòng quỹ đó. Dòng
 *   quỹ của đơn bị hủy vì lý do khác (hủy tay, thu hồi) thì giữ nguyên.
 * Chạy lại được.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Lý do của lần "bỏ sổ Lark" trước đó: các dòng sổ này được bật lại. */
export const VPSG_DROP_LEDGER_REASON =
  'Bỏ sổ quỹ Lark Base: quỹ VPSG ghi theo đơn duyệt';
export const MATCH_DAYS = 7;
const MERGE_VOID_PREFIX = 'Trùng dòng sổ quỹ Lark';
/** Dòng quỹ của đơn do các lệnh nhập sổ hủy: được ghi lại nếu đơn không khớp. */
const OWN_VOID_PREFIXES = ['Thay bằng sổ quỹ Lark tới hết', MERGE_VOID_PREFIX];
const DAY = 86400000;

export interface MergeRequest {
  id: number;
  status: string;
  branchId: number | null;
  createdById: number;
  completedAt: Date | null;
  formSnapshot: unknown;
  detailSnapshot?: unknown;
  sourceType: string | null;
  instanceCode: string | null;
}

export interface MergeApproval {
  request: MergeRequest;
  amount: Prisma.Decimal;
  description: string;
  /** Ngày chi tiền, ngày duyệt, ngày gửi (bỏ ngày trống). */
  dates: Date[];
  /** Dòng quỹ đang có của đơn. */
  posted: {
    id: number;
    branchId: number;
    occurredAt: Date;
    sourceKey: string;
    entryId: number | null;
  } | null;
  /** Lý do hủy dòng quỹ của đơn do người dùng / Lark (không phải lệnh nhập sổ). */
  otherCancel: string | null;
  entry: { id: number; live: boolean; flagged: boolean } | null;
}

export interface MergeMatch {
  approval: MergeApproval;
  lark: LedgerTx;
  days: number;
  /** Số dòng sổ cùng số tiền trong cửa sổ khớp của đơn. */
  candidates: number;
}

async function loadApprovals(db: Db, until: Date): Promise<MergeApproval[]> {
  const requests = (await db.approvalRequest.findMany({
    where: {
      branchId: VPSG_BRANCH_ID,
      clientUuid: { startsWith: 'LARK:' },
      status: 'APPROVED',
      sourceType: PAYMENT_VOUCHER.sourceType,
      completedAt: { lt: until },
    },
    select: {
      id: true,
      status: true,
      branchId: true,
      createdById: true,
      completedAt: true,
      formSnapshot: true,
      detailSnapshot: true,
      sourceType: true,
      instanceCode: true,
    },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
  })) as MergeRequest[];
  if (!requests.length) return [];
  const [fundRows, entries] = await Promise.all([
    db.internalFundTransaction.findMany({
      where: {
        branchId: VPSG_BRANCH_ID,
        sourceType: PAYMENT_VOUCHER.sourceType,
      },
      select: {
        id: true,
        branchId: true,
        occurredAt: true,
        sourceKey: true,
        status: true,
        entryId: true,
        cancelReason: true,
      },
    }),
    db.internalFinanceEntry.findMany({
      where: {
        sourceKey: {
          in: requests
            .filter((request) => request.instanceCode)
            .map(
              (request) =>
                `${LARK_APPROVAL_SOURCE_TYPE}:${request.instanceCode}`,
            ),
        },
      },
      select: { id: true, status: true, sourceKey: true, sourceSnapshot: true },
    }),
  ]);
  const rowsByKey = new Map<string, typeof fundRows>();
  for (const row of fundRows) {
    const key = row.sourceKey.split(':CANCELLED:')[0];
    rowsByKey.set(key, [...(rowsByKey.get(key) || []), row]);
  }
  const entryByKey = new Map(
    entries.map((entry) => [String(entry.sourceKey), entry]),
  );

  const approvals: MergeApproval[] = [];
  for (const request of requests) {
    const snapshot = request.formSnapshot as {
      form?: ApprovalFormItem[];
      metadata?: { amount?: number; description?: string };
    } | null;
    if (!snapshot?.metadata?.amount) continue;
    const detail = request.detailSnapshot as { start_time?: unknown } | null;
    const dates = [
      readPaymentVoucherDate(snapshot.form || []),
      request.completedAt,
      larkTime(detail?.start_time),
    ].filter((date): date is Date => Boolean(date));
    const rows =
      rowsByKey.get(fundSourceKey(request.sourceType, request.id)!) || [];
    const posted = rows.find((row) => row.status === 'POSTED') || null;
    const other = rows.find(
      (row) =>
        row.status !== 'POSTED' &&
        !OWN_VOID_PREFIXES.some((prefix) =>
          (row.cancelReason || '').startsWith(prefix),
        ),
    );
    const entry = entryByKey.get(
      `${LARK_APPROVAL_SOURCE_TYPE}:${request.instanceCode}`,
    );
    approvals.push({
      request,
      amount: new Prisma.Decimal(snapshot.metadata.amount),
      description: snapshot.metadata.description || '',
      dates,
      posted,
      otherCancel: other ? other.cancelReason || 'không rõ lý do' : null,
      entry: entry
        ? {
            id: entry.id,
            live: entry.status !== INTERNAL_FINANCE_STATUS.CANCELLED,
            flagged: Boolean(
              (entry.sourceSnapshot as { larkLedgerRecorded?: boolean } | null)
                ?.larkLedgerRecorded,
            ),
          }
        : null,
    });
  }
  return approvals;
}

/** Ghép 1-1 đơn với dòng chi trong sổ: cùng số tiền, lệch ít nhất trước. */
export function matchApprovals(
  approvals: MergeApproval[],
  book: LedgerTx[],
): MergeMatch[] {
  const pairs: Array<{
    approval: MergeApproval;
    lark: LedgerTx;
    days: number;
  }> = [];
  for (const approval of approvals)
    for (const lark of book) {
      if (
        lark.transactionType !== 'EXPENSE' ||
        !lark.amount.equals(approval.amount)
      )
        continue;
      const days =
        Math.min(
          ...approval.dates.map((date) =>
            Math.abs(date.getTime() - lark.occurredAt.getTime()),
          ),
        ) / DAY;
      if (days <= MATCH_DAYS) pairs.push({ approval, lark, days });
    }
  const candidates = new Map<number, number>();
  for (const pair of pairs)
    candidates.set(
      pair.approval.request.id,
      (candidates.get(pair.approval.request.id) || 0) + 1,
    );
  pairs.sort(
    (a, b) => a.days - b.days || a.approval.request.id - b.approval.request.id,
  );
  const usedApprovals = new Set<number>();
  const usedRows = new Set<string>();
  const matches: MergeMatch[] = [];
  for (const pair of pairs) {
    if (
      usedApprovals.has(pair.approval.request.id) ||
      usedRows.has(pair.lark.sourceKey)
    )
      continue;
    usedApprovals.add(pair.approval.request.id);
    usedRows.add(pair.lark.sourceKey);
    matches.push({
      ...pair,
      candidates: candidates.get(pair.approval.request.id) || 1,
    });
  }
  return matches;
}

export interface VpsgMergeOptions {
  /**
   * Đơn kế toán xác nhận đã có trong sổ dù không khớp tự động (ghi gộp, quyết
   * toán tạm ứng, sổ ghi nhầm ngày): xử lý như đơn khớp sổ.
   */
  inLedger?: number[];
}

export async function planVpsgMerge(
  db: Db,
  records: LarkRecord[],
  until = larkLedgerCutoff(VPSG_BRANCH_ID),
  options: VpsgMergeOptions = {},
) {
  const ledger = await planLedgerImport(db, records, VPSG_BRANCH_ID, until, {
    merge: true,
    restoreReason: VPSG_DROP_LEDGER_REASON,
  });
  const approvals = await loadApprovals(db, until);
  const matched = matchApprovals(approvals, ledger.ledger);
  const matchedIds = new Set(matched.map((item) => item.approval.request.id));
  const unmatched = approvals.filter(
    (approval) => !matchedIds.has(approval.request.id),
  );
  const confirmIds = new Set(options.inLedger || []);
  const confirmed = unmatched.filter((approval) =>
    confirmIds.has(approval.request.id),
  );
  const missing = unmatched.filter(
    (approval) => !confirmIds.has(approval.request.id),
  );
  // Số đơn trong --in-ledger không thuộc nhóm "sổ không ghi" (gõ nhầm, đã khớp).
  const unknownConfirm = [...confirmIds].filter(
    (id) => !confirmed.some((approval) => approval.request.id === id),
  );

  // Đã có trong sổ (khớp tự động hoặc kế toán xác nhận): hủy dòng quỹ riêng
  // của đơn; phiếu mang dấu Lark.
  const voids = [
    ...matched
      .filter((item) => item.approval.posted)
      .map((item) => ({
        approval: item.approval,
        reason: `${MERGE_VOID_PREFIX} ${item.lark.code}`,
      })),
    ...confirmed
      .filter((approval) => approval.posted)
      .map((approval) => ({
        approval,
        reason: `${MERGE_VOID_PREFIX} (kế toán xác nhận)`,
      })),
  ];
  const marks = [...matched.map((item) => item.approval), ...confirmed].filter(
    (approval) => approval.entry?.live && !approval.entry.flagged,
  );
  // Sổ thiếu: đơn phải có dòng quỹ.
  const skipped: Array<{ approval: MergeApproval; reason: string }> = [];
  const posts: MergeApproval[] = [];
  const attaches: MergeApproval[] = [];
  for (const approval of missing) {
    if (approval.posted) {
      if (
        approval.entry?.live &&
        (approval.posted.entryId !== approval.entry.id ||
          approval.entry.flagged)
      )
        attaches.push(approval);
    } else if (approval.otherCancel)
      skipped.push({
        approval,
        reason: `Dòng quỹ đã hủy: ${approval.otherCancel}`,
      });
    else if (approval.entry && !approval.entry.live)
      skipped.push({ approval, reason: 'Phiếu đã hủy trên POS' });
    else posts.push(approval);
  }

  const total = (rows: Array<{ amount: Prisma.Decimal }>) =>
    rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
  // Hủy dòng chi của đơn làm quỹ tăng; ghi đơn sổ thiếu làm quỹ giảm.
  const posAfter = ledger.posAfter
    .plus(total(voids.map((item) => item.approval)))
    .minus(total(posts));
  return {
    ledger,
    approvals,
    matched,
    unmatched,
    confirmed,
    unknownConfirm,
    voids,
    marks,
    posts,
    attaches,
    skipped,
    posAfter,
  };
}

export type VpsgMergePlan = Awaited<ReturnType<typeof planVpsgMerge>>;

/** Phiếu của đơn đã có trong sổ Lark: Đã chi, mang dấu "Đã trừ quỹ trên Lark". */
async function markLedgerRecorded(
  tx: Prisma.TransactionClient,
  entryId: number,
) {
  const entry = await tx.internalFinanceEntry.findUnique({
    where: { id: entryId },
    select: { sourceSnapshot: true },
  });
  await tx.internalFinanceEntry.update({
    where: { id: entryId },
    data: {
      sourceSnapshot: {
        ...((entry?.sourceSnapshot as object) || {}),
        larkLedgerRecorded: true,
      } as Prisma.InputJsonValue,
      cashIssued: true,
      cashIssuedReason: LARK_LEDGER_RECORDED_REASON,
    },
  });
}

/** Gắn phiếu vào dòng quỹ của đơn; phiếu giờ trừ quỹ trên POS nên bỏ dấu Lark. */
export async function attachEntry(
  tx: Prisma.TransactionClient,
  fundId: number,
  entryId: number,
) {
  const fund = await tx.internalFundTransaction.findUnique({
    where: { id: fundId },
    select: { entryId: true },
  });
  if (fund && !fund.entryId)
    await tx.internalFundTransaction.update({
      where: { id: fundId },
      data: { entryId },
    });
  const entry = await tx.internalFinanceEntry.findUnique({
    where: { id: entryId },
    select: { sourceSnapshot: true, cashIssuedReason: true },
  });
  const snapshot = { ...((entry?.sourceSnapshot as object) || {}) } as {
    larkLedgerRecorded?: boolean;
  };
  delete snapshot.larkLedgerRecorded;
  await tx.internalFinanceEntry.update({
    where: { id: entryId },
    data: {
      sourceSnapshot: snapshot as Prisma.InputJsonValue,
      cashIssued: true,
      ...(entry?.cashIssuedReason === LARK_LEDGER_RECORDED_REASON
        ? { cashIssuedReason: LARK_APPROVED_REASON }
        : {}),
    },
  });
}

export async function applyVpsgMerge(
  prisma: PrismaClient,
  records: LarkRecord[],
  userId: number,
  until = larkLedgerCutoff(VPSG_BRANCH_ID),
  options: VpsgMergeOptions = {},
) {
  assertApplyUntil(VPSG_BRANCH_ID, until);
  const ledger = new InternalFundLedgerService();
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [VPSG_BRANCH_ID]);
      const plan = await planVpsgMerge(tx, records, until, options);
      if (plan.unknownConfirm.length)
        throw new Error(
          `--in-ledger có đơn không thuộc nhóm "sổ không ghi": ${plan.unknownConfirm.map((id) => `#${id}`).join(', ')}`,
        );
      await applyLedgerPlan(tx, plan.ledger, userId, ledger);

      for (const { approval, reason } of plan.voids)
        await ledger.releaseCancelled(tx, approval.posted!, userId, reason);
      for (const approval of plan.marks)
        await markLedgerRecorded(tx, approval.entry!.id);

      for (const approval of plan.posts) {
        await ledger.applyPaymentVoucher(tx, approval.request);
        if (!approval.entry) continue;
        const fund = await tx.internalFundTransaction.findUnique({
          where: {
            sourceKey: fundSourceKey(
              approval.request.sourceType,
              approval.request.id,
            )!,
          },
          select: { id: true },
        });
        if (fund) await attachEntry(tx, fund.id, approval.entry.id);
      }
      for (const approval of plan.attaches)
        await attachEntry(tx, approval.posted!.id, approval.entry!.id);
      return plan;
    },
    { timeout: 600000, maxWait: 60000 },
  );
}
