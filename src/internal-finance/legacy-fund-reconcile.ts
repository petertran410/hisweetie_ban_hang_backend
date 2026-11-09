import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Đối soát một lần quỹ Kho HN / Kho SG với sổ quỹ LarkBase ("Giao Dịch Tiền
 * Mặt - Kho"). Sổ quỹ Lark là số đúng đến hết ngày chốt sổ cuối trên Lark
 * (10/10/2026); sau mốc đó chỉ báo cáo, không sửa.
 *
 * 1. Dòng sổ quỹ Lark ≤ mốc: thêm dòng POS còn thiếu, sửa dòng khác, hủy dòng
 *    không còn trên Lark. Dòng có cả Thu và Chi thành hai giao dịch.
 * 2. Phiếu chi đã có dòng sổ quỹ Lark: hủy giao dịch quỹ POS ghi thêm cho phiếu.
 * 3. Khoản chi POS tự ghi lúc nhập lịch sử (≤ mốc): hủy, phiếu giữ "Đã chi".
 * 4. Phiếu đã có dòng sổ quỹ Lark: gắn dấu "đã trừ quỹ trên Lark" (duyệt sau
 *    này chỉ tick Đã chi, không trừ quỹ lần nữa); thuộc tuần đã duyệt thì Đã chi.
 * 5. Phiếu HN chưa đồng kiểm bị ghi quỹ theo approval tuần đồng bộ: trả về chờ kiểm tra.
 * 6. Khoản ghi quỹ theo approval tuần: chuyển sang ngày Approval duyệt (ngày tiền ra).
 * 7. Luật POS: phiếu trong approval tuần đang chờ duyệt thì chưa "Đã chi" — bỏ
 *    dấu Đã chi do dữ liệu Lark / script trước đặt. Phiếu lịch sử ngoài tuần giữ nguyên.
 * 8. Kho SG trên Lark không có hai tick đồng kiểm: phiếu SG đã chi được tick
 *    "Quản lý kho" và "Kế toán kho" theo ngày Đã chi để dữ liệu đồng nhất với POS.
 */
export const HN = 6;
export const SG = 1;
export const BRANCHES = [HN, SG];
export const CUTOFF = new Date('2026-10-11T00:00:00+07:00');
/** Khoản chi tự ghi lúc nhập lịch sử đều tạo trước ngày dùng POS. */
export const IMPORT_POSTED_BEFORE = new Date('2026-10-14T00:00:00+07:00');
export const LEDGER_PREFIX = 'LARK_LEDGER:';

export const REASON = {
  removedOnLark: 'Dòng sổ quỹ không còn trên Lark',
  noTradeDate: 'Thiếu ngày giao dịch trên Lark, Lark không tính vào quỹ',
  duplicateOfLark: 'Trùng sổ quỹ Lark',
  importPosting: 'Lark không trừ quỹ khoản này (đối soát sổ quỹ Lark)',
  unchecked: 'Chưa đồng kiểm, không thuộc approval tuần',
  larkPaid: 'Đã chi và ghi sổ quỹ trên Lark',
  paidOnLark: 'Đã chi trên Lark',
  ledgerRecorded: 'Đã trừ quỹ trên Lark',
};
/** Tuần chưa có kết quả duyệt. */
const PENDING_WEEK_STATUSES = ['DRAFT', 'READY', 'IN_APPROVAL'];
const LARK_ISSUED_REASONS = [
  REASON.larkPaid,
  REASON.paidOnLark,
  REASON.ledgerRecorded,
];

export interface LarkRecord {
  recordId: string;
  fields: Record<string, unknown>;
  createdAt?: Date | null;
  modifiedAt?: Date | null;
}

export interface LedgerTx {
  sourceKey: string;
  recordId: string;
  code: string;
  branchId: number;
  transactionType: 'RECEIPT' | 'EXPENSE' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amount: Prisma.Decimal;
  occurredAt: Date;
  description: string;
  status: 'POSTED' | 'CANCELLED';
  /** Lý do khi dòng được giữ nhưng không tính vào quỹ. */
  cancelReason: string | null;
  linkedRecordIds: string[];
  createdAt: Date | null;
  modifiedAt: Date | null;
}

const unwrap = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (inner !== undefined) return unwrap(inner);
  }
  return value;
};

export function readNumber(value: unknown): number {
  const raw = unwrap(value);
  if (Array.isArray(raw)) return readNumber(raw[0]);
  const number = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : raw;
  return typeof number === 'number' && Number.isFinite(number) ? number : 0;
}

export function readText(value: unknown): string {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (Array.isArray(raw))
    return raw
      .map((item) =>
        item && typeof item === 'object'
          ? readText(
              (item as { text?: unknown; name?: unknown }).text ??
                (item as { name?: unknown }).name,
            )
          : readText(item),
      )
      .join('');
  if (typeof raw === 'object' && 'text' in raw)
    return readText((raw as { text: unknown }).text);
  return '';
}

function readDate(value: unknown): Date | null {
  const raw = unwrap(value);
  const ms = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

export function readLinks(value: unknown): string[] {
  const raw = unwrap(value);
  if (!raw) return [];
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const ids = (raw as { link_record_ids?: unknown }).link_record_ids;
    return Array.isArray(ids) ? ids.map(String) : [];
  }
  if (Array.isArray(raw))
    return raw.flatMap((item) =>
      typeof item === 'string'
        ? [item]
        : item && typeof item === 'object'
          ? [
              ...(((item as { record_ids?: unknown[] }).record_ids ||
                []) as string[]),
              ...((item as { id?: string }).id
                ? [(item as { id: string }).id]
                : []),
            ]
          : [],
    );
  return [];
}

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();

/** Chỉ hai quỹ kho; văn phòng, cửa hàng… không thuộc phạm vi đối soát. */
export function warehouseBranch(label: string): number | null {
  const text = normalize(label);
  if (!text.includes('kho')) return null;
  if (text.includes('ha noi')) return HN;
  if (text.includes('sai gon')) return SG;
  return null;
}

export const VPHN = 4;
export const VPSG = 7;

/** Bốn quỹ tiền mặt có trên POS theo cột "Chi Nhánh" của sổ quỹ Lark. */
export function ledgerBranch(label: string): number | null {
  const warehouse = warehouseBranch(label);
  if (warehouse) return warehouse;
  const text = normalize(label);
  if (!text.includes('van phong')) return null;
  if (text.includes('ha noi')) return VPHN;
  if (text.includes('sai gon')) return VPSG;
  return null;
}

/**
 * Một dòng sổ quỹ Lark → 0, 1 hoặc 2 giao dịch (Thu và Chi tính riêng như
 * công thức Lark). `resolveBranch` chọn quỹ nào được nhận (mặc định hai kho).
 */
export function mapLedgerRecord(
  record: LarkRecord,
  resolveBranch: (label: string) => number | null = warehouseBranch,
): LedgerTx[] {
  const fields = record.fields;
  const branchId = resolveBranch(readText(fields['Chi Nhánh']));
  if (!branchId) return [];
  // Lark chỉ tính số dư theo "Ngày Giao Dịch": dòng thiếu ngày này vẫn giữ (theo
  // ngày tạo) để tra cứu nhưng không tính vào quỹ.
  const tradeDate = readDate(fields['Ngày Giao Dịch']);
  const occurredAt = tradeDate || readDate(fields['Ngày Tạo']);
  if (!occurredAt) return [];
  const cancelledOnLark =
    normalize(readText(fields['Trạng Thái'])).trim() === 'huy';
  const receipt = readNumber(fields['Thu']);
  const expense = readNumber(fields['Chi']);
  const category = readText(fields['Loại Thu Chi']);
  const transfer = normalize(category).trim() === 'chuyen tien noi bo';
  const serial = readText(fields['STT']).trim();
  const base = {
    recordId: record.recordId,
    branchId,
    occurredAt,
    description: readText(fields['Nội Dung']).trim() || category,
    status: (cancelledOnLark || !tradeDate
      ? 'CANCELLED'
      : 'POSTED') as LedgerTx['status'],
    cancelReason: cancelledOnLark
      ? null
      : tradeDate
        ? null
        : REASON.noTradeDate,
    linkedRecordIds: [
      ...readLinks(fields['Phiếu Chi HN']),
      ...readLinks(fields['Phiếu Chi SG']),
    ],
    createdAt: record.createdAt ?? null,
    modifiedAt: record.modifiedAt ?? record.createdAt ?? null,
  };
  const rows: LedgerTx[] = [];
  // Khóa cũ của bước đồng bộ trước: dòng có Thu dùng khóa gốc; Chi đi kèm thêm ":CHI".
  if (receipt > 0)
    rows.push({
      ...base,
      sourceKey: `${LEDGER_PREFIX}${record.recordId}`,
      code: serial ? `SQ-${serial}` : `QF-SQ-${randomUUID()}`,
      transactionType: transfer ? 'TRANSFER_IN' : 'RECEIPT',
      amount: new Prisma.Decimal(receipt),
    });
  if (expense > 0)
    rows.push({
      ...base,
      sourceKey: `${LEDGER_PREFIX}${record.recordId}${receipt > 0 ? ':CHI' : ''}`,
      code: serial
        ? `SQ-${serial}${receipt > 0 ? '-C' : ''}`
        : `QF-SQ-${randomUUID()}`,
      transactionType: transfer ? 'TRANSFER_OUT' : 'EXPENSE',
      amount: new Prisma.Decimal(expense),
    });
  return rows;
}

const signed = (type: string, amount: Prisma.Decimal | number | string) => {
  const value = new Prisma.Decimal(amount);
  return ['RECEIPT', 'TRANSFER_IN'].includes(type) ? value : value.negated();
};

type Db = PrismaClient | Prisma.TransactionClient;

interface FundRow {
  id: number;
  branchId: number;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  sourceKey: string;
  status: string;
  description: string | null;
  entryId: number | null;
}

const fundSelect = {
  id: true,
  branchId: true,
  transactionType: true,
  amount: true,
  occurredAt: true,
  sourceKey: true,
  status: true,
  description: true,
  entryId: true,
} as const;

export async function planReconcile(db: Db, records: LarkRecord[]) {
  const mapped = records.flatMap((record) => mapLedgerRecord(record));
  const byKey = new Map(mapped.map((row) => [row.sourceKey, row]));
  const larkIds = new Set(records.map((record) => record.recordId));
  const posLedger: FundRow[] = await db.internalFundTransaction.findMany({
    where: {
      sourceType: 'LEDGER_HISTORY',
      sourceKey: { startsWith: LEDGER_PREFIX },
      branchId: { in: BRANCHES },
    },
    select: fundSelect,
  });
  const posByKey = new Map(posLedger.map((row) => [row.sourceKey, row]));

  // 1. Sổ quỹ Lark ≤ mốc.
  const add: LedgerTx[] = [];
  const update: Array<{ pos: FundRow; lark: LedgerTx }> = [];
  for (const lark of mapped) {
    if (lark.occurredAt >= CUTOFF) continue;
    const pos = posByKey.get(lark.sourceKey);
    if (!pos) {
      if (lark.status === 'POSTED') add.push(lark);
      continue;
    }
    const changed =
      pos.branchId !== lark.branchId ||
      pos.transactionType !== lark.transactionType ||
      !pos.amount.equals(lark.amount) ||
      pos.occurredAt.getTime() !== lark.occurredAt.getTime() ||
      pos.status !== lark.status;
    if (changed) update.push({ pos, lark });
  }
  const removed = posLedger.filter((pos) => {
    if (pos.status !== 'POSTED' || pos.occurredAt >= CUTOFF) return false;
    const recordId = pos.sourceKey.slice(LEDGER_PREFIX.length).split(':')[0];
    return !larkIds.has(recordId) || !byKey.has(pos.sourceKey);
  });

  // Dòng sổ quỹ còn hiệu lực sau đối soát → phiếu chi gắn với chúng đã trừ quỹ.
  const effectiveLedger = mapped.filter((lark) =>
    lark.occurredAt < CUTOFF
      ? lark.status === 'POSTED'
      : posByKey.get(lark.sourceKey)?.status === 'POSTED',
  );
  const linkedRecordIds = new Set(
    effectiveLedger.flatMap((lark) => lark.linkedRecordIds),
  );
  const importedEntries = await db.internalFinanceEntry.findMany({
    where: {
      branchId: { in: BRANCHES },
      sourceType: 'LARK_IMPORT',
      direction: 'EXPENSE',
    },
    select: { id: true, sourceKey: true },
  });
  const linkedEntryIds = importedEntries
    .filter((entry) =>
      linkedRecordIds.has(String(entry.sourceKey).split(':').pop() || ''),
    )
    .map((entry) => entry.id);

  const entryPostings: Array<
    FundRow & { approvalRequestId: number | null; createdAt: Date }
  > = await db.internalFundTransaction.findMany({
    where: {
      status: 'POSTED',
      sourceType: 'INTERNAL_FINANCE_ENTRY',
      branchId: { in: BRANCHES },
      entry: { sourceType: 'LARK_IMPORT' },
    },
    select: { ...fundSelect, approvalRequestId: true, createdAt: true },
  });
  const taken = new Set<number>();
  // 2. Phiếu đã có dòng sổ quỹ Lark.
  const linkedIdSet = new Set(linkedEntryIds);
  const duplicates = entryPostings.filter(
    (row) => row.entryId !== null && linkedIdSet.has(row.entryId),
  );
  duplicates.forEach((row) => taken.add(row.id));
  // 3. Khoản tự ghi lúc nhập lịch sử.
  const importOnly = entryPostings.filter(
    (row) =>
      !taken.has(row.id) &&
      row.approvalRequestId === null &&
      row.createdAt < IMPORT_POSTED_BEFORE,
  );
  const importPostings = importOnly.filter((row) => row.occurredAt < CUTOFF);
  const importAfterCutoff = importOnly.filter(
    (row) => row.occurredAt >= CUTOFF,
  );
  importPostings.forEach((row) => taken.add(row.id));
  // 5. HN chưa đồng kiểm theo approval tuần đồng bộ.
  const uncheckedRows = await db.internalFundTransaction.findMany({
    where: {
      status: 'POSTED',
      sourceType: 'INTERNAL_FINANCE_ENTRY',
      approvalRequest: { sourceType: 'LARK_IMPORT_WEEKLY' },
      entry: {
        branchId: HN,
        OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
      },
    },
    select: fundSelect,
  });
  const unchecked = uncheckedRows.filter((row) => !taken.has(row.id));

  // 4. Phiếu đã trừ quỹ trên Lark thuộc tuần đã duyệt mà chưa Đã chi.
  const approvedUnissued = await db.internalFinanceEntry.aggregate({
    where: {
      id: { in: linkedEntryIds },
      cashIssued: false,
      weeklyBatch: { status: 'APPROVED' },
    },
    _count: true,
    _sum: { amount: true },
  });

  // 7. Phiếu đang "Đã chi" do dữ liệu Lark nhưng chưa thuộc approval đã duyệt:
  // sau đối soát không còn giao dịch quỹ → trả về chưa chi theo luật POS.
  const cancelledEntryIds = new Set(
    [...duplicates, ...importPostings]
      .map((row) => row.entryId)
      .filter((id): id is number => id !== null),
  );
  const issuedOutsideApproval = await db.internalFinanceEntry.findMany({
    where: {
      branchId: { in: BRANCHES },
      direction: 'EXPENSE',
      cashIssued: true,
      weeklyBatch: { status: { in: PENDING_WEEK_STATUSES } },
    },
    select: {
      id: true,
      branchId: true,
      amount: true,
      cashIssuedReason: true,
      weeklyBatch: { select: { code: true } },
      fundTransaction: { select: { id: true, status: true } },
    },
  });
  // 8. SG đã chi (sau bước 7) còn thiếu tick đồng kiểm.
  const sgPaidUnchecked = await db.internalFinanceEntry.findMany({
    where: {
      branchId: SG,
      sourceType: 'LARK_IMPORT',
      direction: 'EXPENSE',
      cashIssued: true,
      OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
    },
    select: {
      id: true,
      amount: true,
      weeklyBatch: { select: { status: true } },
    },
  });
  const revertIssued = issuedOutsideApproval.filter(
    (entry) =>
      (LARK_ISSUED_REASONS.includes(entry.cashIssuedReason || '') &&
        !entry.fundTransaction) ||
      cancelledEntryIds.has(entry.id),
  );

  // 6. Khoản ghi theo approval tuần còn mang ngày của phiếu → ngày duyệt.
  const approvalPostings = await db.internalFundTransaction.findMany({
    where: {
      status: 'POSTED',
      sourceType: 'INTERNAL_FINANCE_ENTRY',
      branchId: { in: BRANCHES },
      approvalRequest: { completedAt: { not: null } },
    },
    select: {
      ...fundSelect,
      approvalRequest: { select: { completedAt: true, detailSnapshot: true } },
    },
  });
  // Ngày duyệt thật lấy từ Lark (end_time); completedAt của tuần đồng bộ có thể
  // chỉ là ngày cuối tuần do bước nhập lịch sử đặt.
  const approvedAt = (request: {
    completedAt: Date | null;
    detailSnapshot: Prisma.JsonValue;
  }) => {
    const end = Number(
      (request.detailSnapshot as { end_time?: unknown } | null)?.end_time,
    );
    return end > 0 ? new Date(end) : request.completedAt!;
  };
  const redate = approvalPostings
    .map((row) => ({ ...row, issuedAt: approvedAt(row.approvalRequest!) }))
    .filter(
      (row) =>
        !taken.has(row.id) &&
        !unchecked.some((item) => item.id === row.id) &&
        row.occurredAt.getTime() !== row.issuedAt.getTime(),
    );

  // Lark tính số dư chỉ theo cột "Ngày Giao Dịch": dòng thiếu ngày này không được
  // công thức Lark cộng vào — liệt kê để đối chiếu phần lệch còn lại.
  const missingTradeDate = records
    .filter(
      (record) =>
        !readDate(record.fields['Ngày Giao Dịch']) &&
        warehouseBranch(readText(record.fields['Chi Nhánh'])) !== null &&
        normalize(readText(record.fields['Trạng Thái'])).trim() !== 'huy',
    )
    .flatMap((record) => mapLedgerRecord(record));

  const afterCutoff = mapped.filter((lark) => lark.occurredAt >= CUTOFF);
  return {
    redate,
    missingTradeDate,
    add,
    update,
    removed,
    linkedEntryIds,
    duplicates,
    importPostings,
    importAfterCutoff,
    unchecked,
    approvedUnissued,
    revertIssued,
    // Phiếu sắp bị trả về chưa chi (bước 7) không được tick.
    sgPaidUnchecked: sgPaidUnchecked.filter(
      (entry) =>
        !PENDING_WEEK_STATUSES.includes(entry.weeklyBatch?.status || ''),
    ),
    afterCutoff: {
      missingInPos: afterCutoff.filter(
        (lark) => lark.status === 'POSTED' && !posByKey.has(lark.sourceKey),
      ),
      inPos: afterCutoff.filter((lark) => posByKey.has(lark.sourceKey)),
    },
  };
}

export type ReconcilePlan = Awaited<ReturnType<typeof planReconcile>>;

/** Chênh lệch số dư mỗi kho mà kế hoạch gây ra, tính đến trước `until` (hoặc toàn bộ). */
export function balanceDelta(plan: ReconcilePlan, until?: Date) {
  const delta = new Map(BRANCHES.map((id) => [id, new Prisma.Decimal(0)]));
  const inRange = (date: Date) => !until || date < until;
  const add = (branchId: number, value: Prisma.Decimal) =>
    delta.set(
      branchId,
      (delta.get(branchId) || new Prisma.Decimal(0)).plus(value),
    );
  for (const row of plan.add)
    if (inRange(row.occurredAt))
      add(row.branchId, signed(row.transactionType, row.amount));
  for (const { pos, lark } of plan.update) {
    if (pos.status === 'POSTED' && inRange(pos.occurredAt))
      add(pos.branchId, signed(pos.transactionType, pos.amount).negated());
    if (lark.status === 'POSTED' && inRange(lark.occurredAt))
      add(lark.branchId, signed(lark.transactionType, lark.amount));
  }
  for (const row of [
    ...plan.removed,
    ...plan.duplicates,
    ...plan.importPostings,
    ...plan.unchecked,
  ])
    if (inRange(row.occurredAt))
      add(row.branchId, signed(row.transactionType, row.amount).negated());
  for (const row of plan.redate) {
    if (inRange(row.occurredAt))
      add(row.branchId, signed(row.transactionType, row.amount).negated());
    if (inRange(row.issuedAt))
      add(row.branchId, signed(row.transactionType, row.amount));
  }
  return delta;
}

export async function fundBalance(db: Db, until?: Date) {
  const rows = await db.internalFundTransaction.groupBy({
    by: ['branchId', 'transactionType'],
    where: {
      branchId: { in: BRANCHES },
      status: 'POSTED',
      ...(until ? { occurredAt: { lt: until } } : {}),
    },
    _sum: { amount: true },
  });
  const balance = new Map(BRANCHES.map((id) => [id, new Prisma.Decimal(0)]));
  for (const row of rows)
    balance.set(
      row.branchId,
      balance
        .get(row.branchId)!
        .plus(signed(row.transactionType, row._sum.amount || 0)),
    );
  return balance;
}

async function cancelRow(
  tx: Prisma.TransactionClient,
  row: { id: number; sourceKey: string },
  userId: number,
  reason: string,
) {
  await tx.internalFundTransaction.update({
    where: { id: row.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: reason,
      entryId: null,
      sourceKey: `${row.sourceKey}:CANCELLED:${row.id}`,
    },
  });
}

export async function applyReconcile(
  prisma: PrismaClient,
  records: LarkRecord[],
  userId: number,
) {
  return prisma.$transaction(
    async (tx) => {
      for (const id of [...BRANCHES].sort((a, b) => a - b))
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(68125, ${id}::integer)`;
      const plan = await planReconcile(tx, records);

      // 1. Sổ quỹ Lark ≤ mốc.
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
      for (const { pos, lark } of plan.update)
        await tx.internalFundTransaction.update({
          where: { id: pos.id },
          data: {
            branchId: lark.branchId,
            transactionType: lark.transactionType,
            amount: lark.amount,
            occurredAt: lark.occurredAt,
            description: lark.description,
            status: lark.status,
            cancelledAt: lark.status === 'CANCELLED' ? new Date() : null,
            cancelledBy: lark.status === 'CANCELLED' ? userId : null,
            cancelReason: lark.cancelReason,
            ...(lark.modifiedAt ? { updatedAt: lark.modifiedAt } : {}),
          },
        });
      for (const row of plan.removed)
        await cancelRow(tx, row, userId, REASON.removedOnLark);

      // 2 + 3. Hủy khoản ghi quỹ thừa; phiếu giữ "Đã chi".
      for (const row of plan.duplicates)
        await cancelRow(tx, row, userId, REASON.duplicateOfLark);
      for (const row of plan.importPostings)
        await cancelRow(tx, row, userId, REASON.importPosting);
      // 4. Dấu "đã trừ quỹ trên Lark" (không hiện trên giao diện).
      if (plan.linkedEntryIds.length)
        await tx.$executeRaw`
          UPDATE internal_finance_entries
          SET "sourceSnapshot" = COALESCE("sourceSnapshot", '{}'::jsonb) || '{"larkLedgerRecorded": true}'::jsonb
          WHERE id IN (${Prisma.join(plan.linkedEntryIds)})`;
      const duplicateEntryIds = plan.duplicates
        .map((row) => row.entryId)
        .filter((id): id is number => id !== null);
      if (duplicateEntryIds.length)
        await tx.internalFinanceEntry.updateMany({
          where: { id: { in: duplicateEntryIds } },
          data: { cashIssuedReason: REASON.ledgerRecorded },
        });
      if (plan.linkedEntryIds.length)
        await tx.$executeRaw`
          UPDATE internal_finance_entries e
          SET "cashIssued" = true,
              "cashIssuedAt" = e."occurredAt",
              "cashIssuedReason" = ${REASON.ledgerRecorded}
          FROM internal_finance_weekly_batches b
          WHERE b.id = e."weeklyBatchId"
            AND b.status = 'APPROVED'
            AND e."cashIssued" = false
            AND e.id IN (${Prisma.join(plan.linkedEntryIds)})`;
      const importEntryIds = plan.importPostings
        .map((row) => row.entryId)
        .filter((id): id is number => id !== null);
      if (importEntryIds.length)
        await tx.internalFinanceEntry.updateMany({
          where: { id: { in: importEntryIds } },
          data: { cashIssuedReason: REASON.paidOnLark },
        });

      // 5. HN chưa đồng kiểm.
      for (const row of plan.unchecked) {
        await cancelRow(tx, row, userId, REASON.unchecked);
        if (row.entryId)
          await tx.internalFinanceEntry.update({
            where: { id: row.entryId },
            data: {
              cashIssued: false,
              cashIssuedAt: null,
              cashIssuedBy: null,
              cashIssuedReason: null,
              weeklyBatchId: null,
              status: 'PENDING_ACCOUNTANT',
            },
          });
      }

      // 7. Luật POS: chưa thuộc approval đã duyệt thì chưa Đã chi.
      await tx.$executeRaw`
        UPDATE internal_finance_entries e
        SET "cashIssued" = false,
            "cashIssuedAt" = NULL,
            "cashIssuedBy" = NULL,
            "cashIssuedReason" = NULL
        WHERE e."branchId" IN (${Prisma.join(BRANCHES)})
          AND e.direction = 'EXPENSE'
          AND e."cashIssued" = true
          AND e."cashIssuedReason" IN (${Prisma.join(LARK_ISSUED_REASONS)})
          AND NOT EXISTS (
            SELECT 1 FROM internal_fund_transactions t
            WHERE t."entryId" = e.id AND t.status = 'POSTED')
          AND EXISTS (
            SELECT 1 FROM internal_finance_weekly_batches b
            WHERE b.id = e."weeklyBatchId"
              AND b.status IN (${Prisma.join(PENDING_WEEK_STATUSES)}))`;

      // 8. Kho SG: phiếu đã chi tick đủ hai đồng kiểm (không có người tick trên Lark).
      await tx.$executeRaw`
        UPDATE internal_finance_entries
        SET "managerReviewedAt" = COALESCE("managerReviewedAt", "cashIssuedAt", "occurredAt"),
            "accountantReviewedAt" = COALESCE("accountantReviewedAt", "cashIssuedAt", "occurredAt")
        WHERE "branchId" = ${SG}
          AND "sourceType" = 'LARK_IMPORT'
          AND direction = 'EXPENSE'
          AND "cashIssued" = true
          AND ("managerReviewedAt" IS NULL OR "accountantReviewedAt" IS NULL)`;

      // 6. Ghi quỹ theo approval tuần vào ngày duyệt.
      for (const row of plan.redate)
        await tx.internalFundTransaction.update({
          where: { id: row.id },
          data: { occurredAt: row.issuedAt },
        });

      // Chốt sổ từ ngày sớm nhất bị ảnh hưởng phải đối soát lại.
      const touched = [
        ...plan.add,
        ...plan.update.map((item) => item.lark),
        ...plan.removed,
        ...plan.duplicates,
        ...plan.importPostings,
        ...plan.unchecked,
        ...plan.redate,
      ];
      for (const branchId of BRANCHES) {
        const dates = touched
          .filter((row) => row.branchId === branchId)
          .map((row) => row.occurredAt.getTime());
        if (!dates.length) continue;
        await tx.internalFundDailyClosing.updateMany({
          where: {
            branchId,
            closingDate: {
              gte: new Date(
                new Date(Math.min(...dates)).toISOString().slice(0, 10),
              ),
            },
            closedAt: { not: null },
          },
          data: { reconciliationStatus: 'PENDING' },
        });
      }
      return plan;
    },
    { timeout: 600000, maxWait: 60000 },
  );
}
