import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { larkLedgerCutoff } from '../approval-lifecycle/approval-lifecycle.constants';
import { branchLabel } from '../finance-audit';
import {
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from '../internal-fund/internal-fund-ledger.service';
import {
  ENTRY_AUDIT_SELECT,
  flushScriptLog,
  pushEntryScriptUpdate,
  pushFundRestore,
  pushFundScriptUpdate,
  pushScriptRun,
  scriptRun,
  type ScriptCount,
  type ScriptRun,
} from './finance-script-audit';
import {
  LEDGER_PREFIX,
  REASON,
  VPHN,
  VPSG,
  ledgerBranch,
  mapLedgerRecord,
  readText,
  type LarkRecord,
  type LedgerTx,
} from './legacy-fund-reconcile';

/**
 * Văn phòng (VPHN = 4, VPSG = 7): sổ quỹ Lark Base ("Giao Dịch Tiền Mặt - Kho",
 * cột "Chi Nhánh") là nền của quỹ tới trước mốc (`larkLedgerCutoff`); từ mốc
 * POS tự ghi quỹ.
 *
 * 1. Dòng sổ Lark trước mốc chưa có trên POS: thêm (LEDGER_HISTORY).
 * 2. Dòng đã nhập mà Lark đổi: tiền / ngày / Thu-Chi khác thì hủy dòng cũ và
 *    thêm lại; chỉ đổi nội dung thì sửa nội dung; Hủy, xóa hoặc dời ngày qua
 *    mốc thì hủy.
 * 3. Dòng POS tự ghi trước mốc (đơn Lark, phiếu thu, chuyển tiền, phiếu tay):
 *    VPHN hủy hết vì sổ Lark là số đúng. VPSG (`merge`) chỉ hủy dòng có dòng sổ
 *    cùng khoản; đơn PHIẾU CHI đối chiếu riêng ở vpsg-ledger-merge.ts (sổ VPSG
 *    ghi thiếu đơn). Phiếu gắn với dòng bị hủy giữ "Đã chi" và mang dấu "đã trừ
 *    quỹ trên Lark". Dòng cân bằng quỹ không đụng.
 * Chạy lại được nhiều lần: mỗi lần đưa POS về đúng sổ Lark tới mốc.
 */
const TWIN_SPAN = 36 * 3600000;
const CHANGED_REASON = 'Sửa trên sổ quỹ Lark';
/** Đơn chi tiền mặt từ quỹ: chế độ `merge` đối chiếu theo đơn, không hủy hàng loạt. */
const APPROVAL_CASH_SOURCES = ['LARK_PAYMENT_VOUCHER', 'LARK_SALARY_ADVANCE'];

type Db = PrismaClient | Prisma.TransactionClient;

export interface LedgerImportOptions {
  /** VPSG: sổ Lark ghi thiếu đơn, không hủy hàng loạt dòng POS trước mốc. */
  merge?: boolean;
  /** Bật lại dòng sổ đã bị hủy với đúng lý do này (giữ mã và id cũ). */
  restoreReason?: string;
}

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
  cancelReason?: string | null;
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
  cancelReason: true,
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
const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const money = (value: Prisma.Decimal) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

/** Lý do hủy dòng POS tự ghi trước mốc, vd. "... tới hết 31/10/2026". */
export const voidReason = (until: Date) =>
  `Thay bằng sổ quỹ Lark tới hết ${vnDate(new Date(until.getTime() - 1))}`;

export interface SkippedLarkRow {
  recordId: string;
  code: string;
  occurredAt: Date | null;
  description: string;
  amount: number;
  reason: string;
}

export interface LedgerImportPlan {
  branchId: number;
  until: Date;
  /** Dòng sổ Lark sẽ thêm vào POS. */
  add: LedgerTx[];
  /** Dòng sổ Lark đã có trên POS, không đổi. */
  existing: LedgerTx[];
  /** Dòng đã nhập mà Lark đổi tiền / ngày / Thu-Chi: hủy dòng cũ, thêm dòng mới. */
  changed: Array<{ pos: PosFundRow; lark: LedgerTx }>;
  /** Dòng đã nhập chỉ đổi nội dung trên Lark: sửa nội dung. */
  renamed: Array<{ pos: PosFundRow; lark: LedgerTx }>;
  /** Dòng đã nhập nay Lark không còn tính trước mốc: hủy. */
  removed: Array<{ pos: PosFundRow; reason: string }>;
  /** Dòng sổ Lark không tính vào quỹ (Hủy, thiếu ngày, không có số tiền). */
  skipped: SkippedLarkRow[];
  /** Dòng sổ Lark từ mốc trở đi: không nhập (POS tự ghi), chỉ liệt kê. */
  afterCutoff: LedgerTx[];
  /** Mọi dòng sổ Lark tính vào quỹ trước mốc (để đối chiếu đơn). */
  ledger: LedgerTx[];
  /** Dòng sổ đã bị hủy với `restoreReason`, sẽ bật lại (khóa gốc). */
  restored: PosFundRow[];
  /** Dòng POS tự ghi sẽ hủy, kèm dòng Lark cùng khoản (null: không tìm thấy). */
  voids: Array<{ pos: PosFundRow; twin: LedgerTx | null }>;
  /** Số dư sổ Lark tới mốc (chỉ dòng tính vào quỹ). */
  larkBalance: Prisma.Decimal;
  /** Số dư POS tới mốc trước và sau khi áp dụng. */
  posBefore: Prisma.Decimal;
  posAfter: Prisma.Decimal;
}

/** Quỹ lấy lịch sử từ sổ quỹ Lark Base. */
export const LEDGER_IMPORT_BRANCHES = [VPHN, VPSG];

export function assertOfficeBranch(branchId: number) {
  if (!LEDGER_IMPORT_BRANCHES.includes(branchId))
    throw new Error(
      `Chỉ nhập sổ quỹ Lark cho văn phòng (--branch=${LEDGER_IMPORT_BRANCHES.join(' hoặc ')})`,
    );
}

/** Mốc "hết ngày `to`" theo giờ Việt Nam; không có thì lấy mốc của văn phòng. */
export function untilOf(branchId: number, to?: string) {
  if (!to) return larkLedgerCutoff(branchId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to))
    throw new Error('--to phải có dạng YYYY-MM-DD');
  return new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86400000);
}

export async function officeFundBalance(
  db: Db,
  branchId: number,
  until?: Date,
) {
  const rows = await db.internalFundTransaction.groupBy({
    by: ['transactionType'],
    where: {
      branchId,
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

const sameMoney = (pos: PosFundRow, lark: LedgerTx) =>
  pos.status === 'POSTED' &&
  pos.transactionType === lark.transactionType &&
  pos.amount.equals(lark.amount) &&
  pos.occurredAt.getTime() === lark.occurredAt.getTime();

export async function planLedgerImport(
  db: Db,
  records: LarkRecord[],
  branchId: number,
  until = larkLedgerCutoff(branchId),
  options: LedgerImportOptions = {},
): Promise<LedgerImportPlan> {
  assertOfficeBranch(branchId);
  if (branchId === VPSG && !options.merge)
    throw new Error(
      'VPSG nhập sổ Lark ở chế độ kết hợp với đơn duyệt (vpsg-ledger-merge)',
    );
  const officeRecords = records.filter(
    (record) => ledgerBranch(readText(record.fields['Chi Nhánh'])) === branchId,
  );
  const skipped: SkippedLarkRow[] = [];
  const mapped: LedgerTx[] = [];
  const afterCutoff: LedgerTx[] = [];
  // Mọi dòng Lark của văn phòng theo khóa, để nói rõ vì sao dòng đã nhập bị hủy.
  const larkByKey = new Map<string, LedgerTx>();
  for (const record of officeRecords) {
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
      larkByKey.set(row.sourceKey, row);
      if (row.occurredAt >= until) {
        if (row.status === 'POSTED') afterCutoff.push(row);
        continue;
      }
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
    where: { branchId, occurredAt: { lt: until } },
    select: fundSelect,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const ledgerPos = posRows.filter((row) =>
    row.sourceKey.startsWith(LEDGER_PREFIX),
  );
  const posByKey = new Map(ledgerPos.map((row) => [row.sourceKey, row]));
  // Dòng sổ bị hủy hàng loạt trước đó (khóa "X:CANCELLED:id"): bật lại với khóa
  // X, coi như đang có trên POS rồi so với Lark như mọi dòng khác.
  const restored: PosFundRow[] = [];
  if (options.restoreReason)
    for (const row of ledgerPos) {
      const original = /^(.*):CANCELLED:\d+$/.exec(row.sourceKey)?.[1];
      if (
        row.status !== 'CANCELLED' ||
        row.cancelReason !== options.restoreReason ||
        !original ||
        posByKey.has(original)
      )
        continue;
      const live = { ...row, sourceKey: original, status: 'POSTED' };
      posByKey.set(original, live);
      restored.push(live);
    }
  const add: LedgerTx[] = [];
  const existing: LedgerTx[] = [];
  const changed: LedgerImportPlan['changed'] = [];
  const renamed: LedgerImportPlan['renamed'] = [];
  for (const lark of mapped) {
    const pos = posByKey.get(lark.sourceKey);
    if (!pos) add.push(lark);
    // Khác tiền / ngày / Thu-Chi, hoặc POS đang hủy mà Lark tính lại.
    else if (!sameMoney(pos, lark)) changed.push({ pos, lark });
    else if ((pos.description || '') !== lark.description)
      renamed.push({ pos, lark });
    else existing.push(lark);
  }
  const mappedKeys = new Set(mapped.map((row) => row.sourceKey));
  const removed = [...posByKey.values()]
    .filter((pos) => pos.status === 'POSTED' && !mappedKeys.has(pos.sourceKey))
    .map((pos) => {
      const lark = larkByKey.get(pos.sourceKey);
      const reason = !lark
        ? REASON.removedOnLark
        : lark.occurredAt >= until
          ? `Lark đổi ngày sang ${vnDate(lark.occurredAt)}, từ mốc POS tự ghi`
          : lark.cancelReason || 'Đã hủy trên Lark';
      return { pos, reason };
    });

  // Dòng POS tự ghi theo đơn Lark (quỹ, phiếu thu, chuyển tiền) trước mốc.
  // `merge`: đơn chi tiền mặt đối chiếu riêng theo đơn; dòng khác chỉ hủy khi
  // sổ có dòng cùng khoản.
  const live = posRows.filter(
    (row) =>
      row.status === 'POSTED' &&
      row.sourceType !== FUND_SOURCE_TYPE.LEDGER_HISTORY &&
      row.sourceType !== FUND_SOURCE_TYPE.BALANCE_ADJUSTMENT &&
      !(options.merge && APPROVAL_CASH_SOURCES.includes(row.sourceType)),
  );
  const taken = new Set<string>();
  const voids = live
    .map((pos) => {
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
    })
    .filter((item) => !options.merge || item.twin);

  const posted = (row: PosFundRow) => row.status === 'POSTED';
  const posBefore = sum(posRows.filter(posted));
  const posAfter = posBefore
    .plus(sum(restored))
    .plus(sum(add))
    .plus(sum(changed.map((item) => item.lark)))
    .minus(sum(changed.map((item) => item.pos).filter(posted)))
    .minus(sum(removed.map((item) => item.pos)))
    .minus(sum(voids.map((item) => item.pos)));
  return {
    branchId,
    until,
    add,
    existing,
    changed,
    renamed,
    removed,
    skipped,
    afterCutoff,
    ledger: mapped,
    restored,
    voids,
    larkBalance: sum(mapped),
    posBefore,
    posAfter,
  };
}

/**
 * Ghi thật đúng tới mốc: sớm hơn thì hở một khoảng không ai ghi quỹ, muộn hơn
 * thì khoản POS đã tự ghi bị tính thêm lần nữa từ sổ Lark.
 */
export function assertApplyUntil(branchId: number, until: Date) {
  const cutoff = larkLedgerCutoff(branchId);
  if (until.getTime() !== cutoff.getTime())
    throw new Error(
      `Ghi thật chỉ được tới mốc trong code (hết ${vnDate(new Date(cutoff.getTime() - 1))}); --to chỉ dùng khi chạy thử`,
    );
}

/** Tên script ghi trong lịch sử (Cài đặt → Lịch sử). */
export const OFFICE_LEDGER_SCRIPT = 'import-office-ledger';

export async function applyLedgerImport(
  prisma: PrismaClient,
  records: LarkRecord[],
  branchId: number,
  userId: number,
  until = larkLedgerCutoff(branchId),
  /** Tham số dòng lệnh, ghi vào lịch sử lần chạy. */
  args: string[] = [],
) {
  assertApplyUntil(branchId, until);
  const run = scriptRun(OFFICE_LEDGER_SCRIPT, userId, args);
  const ledger = new InternalFundLedgerService(run.service);
  return prisma.$transaction(
    async (tx) => {
      await ledger.lock(tx, [branchId]);
      const plan = await planLedgerImport(tx, records, branchId, until);
      const applied = await applyLedgerPlan(tx, plan, userId, ledger, run);
      pushScriptRun(
        run,
        ledgerRunSummary(plan),
        ledgerRunCounts(plan, applied),
        { branchId, metadata: ledgerRunMetadata(plan) },
      );
      await flushScriptLog(tx, run);
      return plan;
    },
    { timeout: 600000, maxWait: 60000 },
  );
}

/** Kết quả ghi kế hoạch nhập sổ ngoài những gì đọc được từ kế hoạch. */
export interface LedgerApplyResult {
  /** Số phiếu mang dấu "Đã trừ quỹ trên Lark" vì dòng quỹ của nó bị hủy. */
  entriesFlagged: number;
}

/** Tóm tắt lần nhập sổ cho dòng FIN_SCRIPT_RUN. */
export function ledgerRunSummary(plan: LedgerImportPlan) {
  const parts = [
    ['thêm', plan.add.length],
    ['Lark sửa tiền/ngày', plan.changed.length],
    ['sửa nội dung', plan.renamed.length],
    ['hủy theo Lark', plan.removed.length],
    ['hủy dòng POS tự ghi', plan.voids.length],
    ['bật lại', plan.restored.length],
  ] as const;
  const changes = parts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`);
  return `Sổ quỹ ${branchLabel(plan.branchId)} tới hết ${vnDate(new Date(plan.until.getTime() - 1))}: ${changes.length ? changes.join(', ') : 'không có thay đổi'}`;
}

export function ledgerRunCounts(
  plan: LedgerImportPlan,
  applied: LedgerApplyResult,
): ScriptCount[] {
  return [
    { key: 'restored', label: 'Dòng sổ bật lại', value: plan.restored.length },
    { key: 'added', label: 'Dòng sổ Lark thêm', value: plan.add.length },
    {
      key: 'changed',
      label: 'Lark sửa tiền / ngày / Thu-Chi (hủy rồi thêm lại)',
      value: plan.changed.length,
    },
    {
      key: 'renamed',
      label: 'Lark chỉ sửa nội dung',
      value: plan.renamed.length,
    },
    {
      key: 'removed',
      label: 'Hủy theo Lark (hủy / xóa / dời qua mốc)',
      value: plan.removed.length,
    },
    { key: 'voids', label: 'Hủy dòng POS tự ghi', value: plan.voids.length },
    {
      key: 'entriesFlagged',
      label: 'Phiếu mang dấu "Đã trừ quỹ trên Lark"',
      value: applied.entriesFlagged,
    },
    {
      key: 'existing',
      label: 'Dòng sổ không đổi',
      value: plan.existing.length,
    },
    { key: 'skipped', label: 'Dòng Lark bỏ qua', value: plan.skipped.length },
    {
      key: 'posBalance',
      label: 'Số dư POS tới mốc',
      value: `${money(plan.posBefore)} → ${money(plan.posAfter)} (sổ Lark ${money(plan.larkBalance)})`,
    },
  ];
}

export function ledgerRunMetadata(plan: LedgerImportPlan) {
  return {
    until: plan.until,
    larkBalance: plan.larkBalance,
    posBefore: plan.posBefore,
    posAfter: plan.posAfter,
  };
}

const RESTORE_REASON = 'Nhập lại sổ quỹ Lark';

/**
 * Ghi kế hoạch nhập sổ (trong transaction đã khóa quỹ). Có `run` (script
 * --apply): thêm dòng lịch sử vào `run.log` (người gọi ghi bằng
 * flushScriptLog) và truyền người chạy vào ledger.
 */
export async function applyLedgerPlan(
  tx: Prisma.TransactionClient,
  plan: LedgerImportPlan,
  userId: number,
  ledger: InternalFundLedgerService,
  run?: ScriptRun,
): Promise<LedgerApplyResult> {
  const { branchId, until } = plan;
  const reason = voidReason(until);
  const actor = run?.actor;

  // 0. Bật lại dòng sổ đã bị hủy hàng loạt: giữ mã, id, khóa gốc. Lịch sử giữ
  // thông tin hủy cũ (đọc trước khi sửa).
  const restoredBefore =
    run && plan.restored.length
      ? new Map(
          (
            await tx.internalFundTransaction.findMany({
              where: { id: { in: plan.restored.map((row) => row.id) } },
              select: {
                id: true,
                code: true,
                branchId: true,
                status: true,
                sourceKey: true,
                amount: true,
                occurredAt: true,
                cancelledAt: true,
                cancelledBy: true,
                cancelReason: true,
              },
            })
          ).map((row) => [row.id, row]),
        )
      : null;
  for (const row of plan.restored) {
    await tx.internalFundTransaction.update({
      where: { id: row.id },
      data: {
        status: 'POSTED',
        sourceKey: row.sourceKey,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
      },
    });
    const before = restoredBefore?.get(row.id);
    if (run && before)
      pushFundRestore(
        run,
        before,
        { status: 'POSTED', sourceKey: row.sourceKey },
        RESTORE_REASON,
      );
  }

  // 3. Hủy dòng POS tự ghi trước; phiếu gắn với nó giữ Đã chi và mang dấu.
  const flaggedIds = [
    ...new Set(
      plan.voids
        .map((item) => item.pos.entryId)
        .filter((id): id is number => Boolean(id)),
    ),
  ];
  const entriesBefore =
    run && flaggedIds.length
      ? await tx.internalFinanceEntry.findMany({
          where: { id: { in: flaggedIds } },
          select: ENTRY_AUDIT_SELECT,
        })
      : [];
  for (const { pos } of plan.voids) {
    await ledger.releaseCancelled(tx, pos, userId, reason, actor);
    if (pos.entryId)
      await tx.$executeRaw`
            UPDATE internal_finance_entries
            SET "sourceSnapshot" = COALESCE("sourceSnapshot", '{}'::jsonb)
                  || '{"larkLedgerRecorded": true}'::jsonb,
                "cashIssuedReason" = ${REASON.ledgerRecorded}
            WHERE id = ${pos.entryId}`;
  }
  if (run)
    for (const entry of entriesBefore)
      pushEntryScriptUpdate(run, entry, {
        cashIssuedReason: REASON.ledgerRecorded,
        sourceSnapshot: {
          ...((entry.sourceSnapshot as object | null) || {}),
          larkLedgerRecorded: true,
        },
      });

  // 2. Dòng đã nhập mà Lark đổi: hủy (hoặc nhả khóa của dòng đã hủy) rồi thêm lại.
  for (const { pos, reason: removedReason } of plan.removed)
    await ledger.releaseCancelled(tx, pos, userId, removedReason, actor);
  for (const { pos } of plan.changed) {
    if (pos.status === 'POSTED')
      await ledger.releaseCancelled(tx, pos, userId, CHANGED_REASON, actor);
    else {
      const sourceKey = `${pos.sourceKey}:CANCELLED:${pos.id}`;
      if (run)
        pushFundScriptUpdate(
          run,
          pos,
          { sourceKey: pos.sourceKey },
          { sourceKey },
          'Nhả khóa dòng đã hủy để thêm lại theo sổ Lark',
        );
      await tx.internalFundTransaction.update({
        where: { id: pos.id },
        data: { sourceKey },
      });
    }
  }
  for (const { pos, lark } of plan.renamed) {
    if (run)
      pushFundScriptUpdate(
        run,
        pos,
        { description: pos.description },
        { description: lark.description },
        'Lark sửa nội dung dòng sổ',
      );
    await tx.internalFundTransaction.update({
      where: { id: pos.id },
      data: { description: lark.description },
    });
  }

  // 1. Thêm dòng sổ Lark còn thiếu và dòng vừa sửa (số lượng ghi ở dòng
  // FIN_SCRIPT_RUN, không ghi lịch sử từng dòng).
  const inserts = [...plan.add, ...plan.changed.map((item) => item.lark)];
  const usedCodes = new Set(
    (
      await tx.internalFundTransaction.findMany({
        where: { code: { in: inserts.map((row) => row.code) } },
        select: { code: true },
      })
    ).map((row) => row.code),
  );
  if (inserts.length)
    await tx.internalFundTransaction.createMany({
      data: inserts.map((row) => ({
        code: usedCodes.has(row.code) ? `QF-SQ-${randomUUID()}` : row.code,
        sourceKey: row.sourceKey,
        branchId: row.branchId,
        transactionType: row.transactionType,
        amount: row.amount,
        occurredAt: row.occurredAt,
        description: row.description,
        sourceType: FUND_SOURCE_TYPE.LEDGER_HISTORY,
        status: 'POSTED',
        createdBy: userId,
        ...(row.createdAt ? { createdAt: row.createdAt } : {}),
        ...(row.modifiedAt ? { updatedAt: row.modifiedAt } : {}),
      })),
    });

  const touched = [
    ...plan.restored.map((row) => row.occurredAt),
    ...inserts.map((row) => row.occurredAt),
    ...plan.changed.map((item) => item.pos.occurredAt),
    ...plan.removed.map((item) => item.pos.occurredAt),
    ...plan.voids.map((item) => item.pos.occurredAt),
  ];
  if (touched.length)
    await ledger.invalidateClosings(
      tx,
      branchId,
      new Date(Math.min(...touched.map((date) => date.getTime()))),
      'nhập sổ quỹ Lark',
      actor,
    );
  return { entriesFlagged: flaggedIds.length };
}
