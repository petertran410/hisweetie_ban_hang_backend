import { Prisma } from '@prisma/client';
import {
  FINANCE_AUDIT_ENTITY,
  FinanceAuditService,
  auditActor,
  entryKindLabel,
  formatDate,
  formatMoney,
  reasonSuffix,
  type AuditActor,
  type FinanceAuditChange,
  type FinanceAuditEntityType,
  type FinanceAuditEntry,
} from '../finance-audit';

/**
 * Lịch sử của script bảo trì tài chính nội bộ chạy `--apply`: mỗi lần chạy ghi
 * MỘT dòng FIN_SCRIPT_RUN (tóm tắt + số lượng + tham số), cùng opId với các
 * dòng sửa từng bản ghi (đổi ngày / khôi phục / script sửa dòng quỹ / sửa
 * phiếu). Dòng quỹ thêm/hủy qua InternalFundLedgerService do ledger tự ghi
 * (truyền `run.actor` vào ledger). Chạy thử (không --apply) không ghi gì.
 */
export interface ScriptRun {
  /** Tên script, vd. 'import-office-ledger'. */
  name: string;
  /** SCRIPT, userId = --user của người chạy. */
  actor: AuditActor;
  service: FinanceAuditService;
  startedAt: Date;
  /** Tham số dòng lệnh (process.argv.slice(2)). */
  args: string[];
  /** Dòng lịch sử chờ ghi (ghi một lần bằng `flushScriptLog`). */
  log: FinanceAuditEntry[];
}

export function scriptRun(
  name: string,
  userId: number,
  args: string[] = [],
  service = new FinanceAuditService(),
): ScriptRun {
  return {
    name,
    actor: auditActor.script(name, userId),
    service,
    startedAt: new Date(),
    args: [...args],
    log: [],
  };
}

/** Một dòng số lượng của lần chạy: hiện trong snapshot.lines và metadata.counts. */
export interface ScriptCount {
  key: string;
  label: string;
  value: number | string;
}

/** Thêm dòng FIN_SCRIPT_RUN (gọi một lần, cuối transaction ghi thật). */
export function pushScriptRun(
  run: ScriptRun,
  summary: string,
  counts: ScriptCount[],
  extra: { branchId?: number | null; metadata?: Record<string, unknown> } = {},
) {
  run.log.push({
    action: 'FIN_SCRIPT_RUN',
    entityType: FINANCE_AUDIT_ENTITY.SCRIPT,
    entityId: `${run.name}:${run.startedAt.toISOString()}`,
    entityCode: run.name,
    branchId: extra.branchId ?? null,
    actor: run.actor,
    params: { name: run.name, summary },
    snapshot: {
      lines: [
        ...counts.map((count) => ({
          label: count.label,
          value: String(count.value),
        })),
        { label: 'Tham số', value: run.args.join(' ') || '—' },
      ],
      args: run.args,
    },
    metadata: {
      ...(extra.metadata ?? {}),
      script: run.name,
      startedAt: run.startedAt,
      counts: Object.fromEntries(
        counts.map((count) => [count.key, count.value]),
      ),
      args: run.args,
    },
  });
}

/** Ghi các dòng đang chờ bằng client truyền vào (tx: commit/rollback cùng thay đổi). */
export async function flushScriptLog(
  db: Parameters<FinanceAuditService['write']>[0],
  run: ScriptRun,
) {
  const entries = run.log.splice(0);
  if (entries.length) await run.service.write(db, entries);
}

/** Nhãn các trường script sửa mà FINANCE_FIELD_LABELS không có. */
const SCRIPT_FIELD_LABELS: Record<string, string> = {
  sourceKey: 'Khóa nguồn',
  entryId: 'Phiếu gắn với dòng quỹ',
  cashIssued: 'Đã chi',
  cashIssuedReason: 'Lý do Đã chi',
  larkLedgerRecorded: 'Đã trừ quỹ trên Lark',
};

/** diff() + nhãn tiếng Việt cho trường ngoài whitelist. [] nếu không đổi. */
export function scriptChanges(
  run: ScriptRun,
  entityType: FinanceAuditEntityType,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): FinanceAuditChange[] {
  return run.service
    .diff(entityType, before, after, fields)
    .map((change) =>
      change.label === change.field && SCRIPT_FIELD_LABELS[change.field]
        ? { ...change, label: SCRIPT_FIELD_LABELS[change.field] }
        : change,
    );
}

export interface ScriptFundRow {
  id: number;
  code: string;
  branchId: number;
}

/** FIN_FUND_TXN_SCRIPT_UPDATE: script sửa thẳng dòng quỹ (chỉ khi có thay đổi). */
export function pushFundScriptUpdate(
  run: ScriptRun,
  row: ScriptFundRow,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  note?: string,
) {
  const changes = scriptChanges(
    run,
    FINANCE_AUDIT_ENTITY.FUND_TXN,
    before,
    after,
    Object.keys(after),
  );
  if (!changes.length) return;
  run.log.push({
    action: 'FIN_FUND_TXN_SCRIPT_UPDATE',
    entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
    entityId: row.id,
    entityCode: row.code,
    branchId: row.branchId,
    actor: run.actor,
    params: { code: row.code },
    changes,
    ...(note
      ? { snapshot: { lines: [{ label: 'Ghi chú', value: note }] } }
      : {}),
    metadata: { script: run.name },
  });
}

/** Trường phiếu cần chụp trước khi script sửa (ghi lịch sử phiếu). */
export const ENTRY_AUDIT_SELECT = {
  id: true,
  code: true,
  category: true,
  branchId: true,
  cashIssued: true,
  cashIssuedReason: true,
  sourceSnapshot: true,
} as const satisfies Prisma.InternalFinanceEntrySelect;

export type EntryAuditRow = Prisma.InternalFinanceEntryGetPayload<{
  select: typeof ENTRY_AUDIT_SELECT;
}>;

const ledgerFlag = (snapshot: unknown) =>
  Boolean(
    snapshot &&
    typeof snapshot === 'object' &&
    (snapshot as { larkLedgerRecorded?: unknown }).larkLedgerRecorded,
  );

const entryState = (row: {
  cashIssued: boolean | null;
  cashIssuedReason: string | null;
  sourceSnapshot: unknown;
}) => ({
  cashIssued: Boolean(row.cashIssued),
  cashIssuedReason: row.cashIssuedReason ?? null,
  larkLedgerRecorded: ledgerFlag(row.sourceSnapshot),
});

/**
 * FIN_ENTRY_UPDATE cho phiếu script sửa (Đã chi / lý do / dấu "Đã trừ quỹ trên
 * Lark"); `after` là các trường sau khi sửa. Không đổi gì thì không ghi.
 */
export function pushEntryScriptUpdate(
  run: ScriptRun,
  before: EntryAuditRow,
  after: {
    cashIssued?: boolean;
    cashIssuedReason?: string | null;
    sourceSnapshot?: unknown;
  },
) {
  const from = entryState(before);
  const to = entryState({ ...before, ...after });
  const changes = scriptChanges(
    run,
    FINANCE_AUDIT_ENTITY.ENTRY,
    from,
    to,
    Object.keys(from),
  );
  if (!changes.length) return;
  run.log.push({
    action: 'FIN_ENTRY_UPDATE',
    entityType: FINANCE_AUDIT_ENTITY.ENTRY,
    entityId: before.id,
    entityCode: before.code,
    branchId: before.branchId,
    actor: run.actor,
    params: {
      kindLabel: entryKindLabel(before.category),
      code: before.code,
      sourceSuffix: ` (script ${run.name})`,
    },
    changes,
    metadata: { script: run.name },
  });
}

export interface RestoredFundRow {
  id: number;
  code: string;
  branchId: number;
  status: string;
  sourceKey: string;
  amount: Prisma.Decimal | number;
  occurredAt: Date;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  cancelReason: string | null;
}

/** FIN_FUND_TXN_RESTORE: bật lại dòng quỹ đã hủy; snapshot giữ thông tin hủy cũ. */
export function pushFundRestore(
  run: ScriptRun,
  before: RestoredFundRow,
  after: { status: string; sourceKey: string },
  reason: string,
) {
  run.log.push({
    action: 'FIN_FUND_TXN_RESTORE',
    entityType: FINANCE_AUDIT_ENTITY.FUND_TXN,
    entityId: before.id,
    entityCode: before.code,
    branchId: before.branchId,
    actor: run.actor,
    params: { code: before.code, reasonSuffix: reasonSuffix(reason) },
    changes: scriptChanges(
      run,
      FINANCE_AUDIT_ENTITY.FUND_TXN,
      { status: before.status, sourceKey: before.sourceKey },
      after,
      ['status', 'sourceKey'],
    ),
    snapshot: {
      lines: [
        { label: 'Số tiền', value: formatMoney(before.amount) },
        { label: 'Ngày ghi quỹ', value: formatDate(before.occurredAt) },
        { label: 'Lý do hủy cũ', value: before.cancelReason || '—' },
        {
          label: 'Hủy lúc',
          value: before.cancelledAt ? formatDate(before.cancelledAt) : '—',
        },
        {
          label: 'Người hủy',
          value: before.cancelledBy ? `#${before.cancelledBy}` : '—',
        },
      ],
      cancelledBefore: {
        status: before.status,
        sourceKey: before.sourceKey,
        cancelledAt: before.cancelledAt,
        cancelledBy: before.cancelledBy,
        cancelReason: before.cancelReason,
      },
    },
    metadata: { script: run.name, cancelReasonBefore: before.cancelReason },
  });
}
