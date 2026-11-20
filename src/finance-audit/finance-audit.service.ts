import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FINANCE_AUDIT_CATALOG,
  isFinanceAuditAction,
} from './finance-audit.catalog';
import {
  financeAuditSystemUserId,
  systemActorName,
} from './finance-audit.actor';
import {
  EMPTY_VALUE,
  FINANCE_CUSTOMER_ID_FIELDS,
  FINANCE_INVOICE_LINK_FIELD,
  FINANCE_USER_ID_FIELDS,
  buildFinanceDiff,
  renderFinanceMessage,
  sanitizeAuditJson,
} from './finance-audit.format';
import {
  FINANCE_AUDIT_CATEGORY,
  type FinanceAuditChange,
  type FinanceAuditDb,
  type FinanceAuditEntityType,
  type FinanceAuditEntry,
} from './finance-audit.types';

type NameMap = Map<number, string>;
/** Tên hiển thị theo id: người dùng, khách hàng ("mã – tên"), hóa đơn (mã). */
interface RefNames {
  users: NameMap;
  customers: NameMap;
  invoices: NameMap;
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function asJson(value: unknown): Prisma.InputJsonValue | undefined {
  const clean = sanitizeAuditJson(value);
  if (clean === undefined || clean === null) return undefined;
  if (
    typeof clean === 'object' &&
    !Array.isArray(clean) &&
    !Object.keys(clean).length
  )
    return undefined;
  return clean as Prisma.InputJsonValue;
}

/** Giá trị gốc from/to của một change (diff() lưu trong detail). */
function rawEnds(change: FinanceAuditChange): { from?: unknown; to?: unknown } {
  const detail = change.detail;
  return detail && typeof detail === 'object'
    ? (detail as { from?: unknown; to?: unknown })
    : {};
}

/** Các id trong một giá trị (một id hoặc mảng id). */
function idsOf(value: unknown): number[] {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list.map(positiveId).filter((id): id is number => id !== null);
}

/** invoiceId của một change hóa đơn liên kết (detail.invoiceId). */
function linkInvoiceId(change: FinanceAuditChange): number | null {
  const detail = change.detail;
  return detail && typeof detail === 'object'
    ? positiveId((detail as { invoiceId?: unknown }).invoiceId)
    : null;
}

/**
 * Ghi lịch sử thao tác tài chính nội bộ vào audit_logs (category
 * internal_finance). Không có tham số constructor: script dùng
 * `new FinanceAuditService()`.
 */
@Injectable()
export class FinanceAuditService {
  /**
   * Ghi các dòng lịch sử bằng MỘT createMany trên client được truyền vào (truyền
   * tx để lịch sử commit/rollback cùng thay đổi). Không tự mở transaction,
   * không nuốt lỗi. Mảng rỗng → không làm gì.
   */
  async write(
    db: FinanceAuditDb,
    entries: FinanceAuditEntry | FinanceAuditEntry[],
  ): Promise<void> {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!list.length) return;
    for (const entry of list) {
      const code = String(entry.action as string);
      if (!isFinanceAuditAction(code))
        throw new Error(`Mã lịch sử tài chính không hợp lệ: ${code}`);
    }
    const names = await this.loadNames(db, list);
    await db.auditLog.createMany({
      data: list.map((entry) => this.toRow(entry, names)),
    });
  }

  /**
   * So sánh trước/sau theo whitelist FINANCE_FIELD_LABELS của loại bản ghi
   * (hoặc `fields`). from/to là chuỗi hiển thị; trả [] nếu không đổi gì (khi
   * đó không ghi dòng sửa).
   */
  diff(
    entityType: FinanceAuditEntityType,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields?: readonly string[],
  ): FinanceAuditChange[] {
    return buildFinanceDiff(entityType, before, after, fields);
  }

  // Một lần user.findMany cho tên người thao tác, người được ghi thay và các
  // trường User.id trong changes; một lần customer.findMany / invoice.findMany
  // (chỉ khi changes có id khách hàng / hóa đơn) để hiện mã, tên thay "#id".
  private async loadNames(
    db: FinanceAuditDb,
    list: FinanceAuditEntry[],
  ): Promise<RefNames> {
    const ids = new Set<number>();
    const customerIds = new Set<number>();
    const invoiceIds = new Set<number>();
    for (const entry of list) {
      const actor = entry.actor;
      const actorId = positiveId(actor.userId);
      if (actor.kind === 'USER' && !actor.userName && actorId) ids.add(actorId);
      const behalf = positiveId(actor.onBehalfOfUserId);
      if (behalf) ids.add(behalf);
      for (const change of entry.changes ?? []) {
        if (change.field === FINANCE_INVOICE_LINK_FIELD) {
          const invoiceId = linkInvoiceId(change);
          if (invoiceId) invoiceIds.add(invoiceId);
          continue;
        }
        const target = FINANCE_USER_ID_FIELDS.has(change.field)
          ? ids
          : FINANCE_CUSTOMER_ID_FIELDS.has(change.field)
            ? customerIds
            : null;
        if (!target) continue;
        const { from, to } = rawEnds(change);
        for (const id of [...idsOf(from), ...idsOf(to)]) target.add(id);
      }
    }
    type Ref = {
      id: number;
      name?: string | null;
      email?: string | null;
      code?: string | null;
    };
    // Tuần tự (không Promise.all): cùng một transaction client.
    const users: Ref[] = ids.size
      ? await db.user.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const customers: Ref[] =
      customerIds.size && typeof db.customer?.findMany === 'function'
        ? await db.customer.findMany({
            where: { id: { in: [...customerIds] } },
            select: { id: true, code: true, name: true },
          })
        : [];
    const invoices: Ref[] =
      invoiceIds.size && typeof db.invoice?.findMany === 'function'
        ? await db.invoice.findMany({
            where: { id: { in: [...invoiceIds] } },
            select: { id: true, code: true },
          })
        : [];
    const toMap = (rows: Ref[] | undefined, text: (row: Ref) => string) =>
      new Map<number, string>(
        (rows ?? []).map((row) => [row.id, text(row) || `#${row.id}`]),
      );
    return {
      users: toMap(users, (user) => user.name || user.email || ''),
      customers: toMap(customers, (customer) =>
        [customer.code, customer.name].filter(Boolean).join(' – '),
      ),
      invoices: toMap(invoices, (invoice) => invoice.code || ''),
    };
  }

  private toRow(
    entry: FinanceAuditEntry,
    refs: RefNames,
  ): Prisma.AuditLogCreateManyInput {
    const names = refs.users;
    const catalog = FINANCE_AUDIT_CATALOG[entry.action];
    const actor = entry.actor;
    const userId = positiveId(actor.userId) ?? financeAuditSystemUserId();
    const userName =
      actor.userName ||
      (actor.kind === 'USER'
        ? names.get(userId) || `User #${userId}`
        : systemActorName(actor) || 'Hệ thống');
    const behalf = positiveId(actor.onBehalfOfUserId);
    const changes = (entry.changes ?? []).map((change) =>
      this.nameChange(change, refs),
    );
    const branchId = positiveId(entry.branchId);
    return {
      actionType: catalog.actionType,
      actionCode: entry.action,
      category: FINANCE_AUDIT_CATEGORY,
      severity: catalog.severity,
      entityType: entry.entityType ?? catalog.entityType,
      entityId: String(entry.entityId),
      entityCode: entry.entityCode ?? null,
      branchId,
      message: renderFinanceMessage(entry.action, entry.params),
      messageTemplate: entry.action,
      messageParams: asJson(entry.params),
      changes: changes.length ? asJson(changes) : undefined,
      snapshot: asJson(entry.snapshot),
      metadata: asJson({
        ...(entry.metadata ?? {}),
        actorKind: actor.kind,
        trigger: actor.trigger ?? null,
        onBehalfOfUserId: behalf,
        ...(behalf && names.has(behalf)
          ? { onBehalfOfUserName: names.get(behalf) }
          : {}),
      }),
      requestId: actor.opId,
      userId,
      userName,
    };
  }

  private nameChange(
    change: FinanceAuditChange,
    refs: RefNames,
  ): FinanceAuditChange {
    const named: FinanceAuditChange = {
      ...change,
      type: change.type ?? 'field_changed',
    };
    if (change.field === FINANCE_INVOICE_LINK_FIELD) {
      // Hóa đơn thêm / gỡ: hiện mã hóa đơn, giữ invoiceId trong detail.
      const invoiceId = linkInvoiceId(change);
      const code = invoiceId ? refs.invoices.get(invoiceId) : undefined;
      if (!code) return named;
      if (change.type === 'item_removed') named.from = code;
      else named.to = code;
      named.detail = {
        ...(change.detail as Record<string, unknown>),
        invoiceCode: code,
      };
      return named;
    }
    const map = FINANCE_USER_ID_FIELDS.has(change.field)
      ? refs.users
      : FINANCE_CUSTOMER_ID_FIELDS.has(change.field)
        ? refs.customers
        : null;
    if (!map) return named;
    const { from, to } = rawEnds(change);
    const label = (value: unknown, fallback: string) => {
      const list = idsOf(value);
      if (!list.length || !list.some((id) => map.has(id))) return fallback;
      return (
        list.map((id) => map.get(id) ?? `#${id}`).join(', ') || EMPTY_VALUE
      );
    };
    named.from = label(from, named.from);
    named.to = label(to, named.to);
    return named;
  }
}
