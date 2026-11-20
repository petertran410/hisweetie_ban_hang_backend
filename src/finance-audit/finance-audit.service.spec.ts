import { Prisma } from '@prisma/client';
import { FinanceAuditService } from './finance-audit.service';
import { auditActor } from './finance-audit.actor';
import {
  FINANCE_AUDIT_ENTITY,
  type FinanceAuditDb,
  type FinanceAuditEntry,
} from './finance-audit.types';

type Row = Prisma.AuditLogCreateManyInput;
type CreateManyArgs = { data: Row[] };
type FindManyArgs = {
  where: { id: { in: number[] } };
  select: Record<string, boolean>;
};
type UserRow = { id: number; name: string; email: string };

function fakeDb(users: UserRow[] = []) {
  const createMany = jest.fn((args: CreateManyArgs) =>
    Promise.resolve({ count: args.data.length }),
  );
  const findMany = jest.fn((args: FindManyArgs) =>
    Promise.resolve(users.filter((user) => args.where.id.in.includes(user.id))),
  );
  const db = {
    auditLog: { createMany },
    user: { findMany },
  } as unknown as FinanceAuditDb;
  const rows = () => createMany.mock.calls.flatMap(([args]) => args.data);
  return { db, createMany, findMany, rows };
}

const USERS: UserRow[] = [
  { id: 5, name: 'Nguyễn An', email: 'an@example.test' },
  { id: 9, name: '', email: 'lan@example.test' },
  { id: 11, name: 'Trần Bình', email: 'binh@example.test' },
];

describe('FinanceAuditService.write', () => {
  const service = new FinanceAuditService();
  const ORIGINAL_ENV = process.env.FINANCE_AUDIT_SYSTEM_USER_ID;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined)
      delete process.env.FINANCE_AUDIT_SYSTEM_USER_ID;
    else process.env.FINANCE_AUDIT_SYSTEM_USER_ID = ORIGINAL_ENV;
  });

  it('does nothing for an empty list', async () => {
    const f = fakeDb(USERS);
    await service.write(f.db, []);
    expect(f.createMany).not.toHaveBeenCalled();
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('writes one row with the catalog fields, rendered message and actor', async () => {
    const f = fakeDb(USERS);
    const actor = auditActor.user({ id: 5, name: 'Nguyễn An' }, 'http', 'op-1');
    await service.write(f.db, {
      action: 'FIN_ENTRY_CREATE',
      entityType: FINANCE_AUDIT_ENTITY.ENTRY,
      entityId: 12,
      entityCode: 'TCNB-HN-0001',
      branchId: 6,
      actor,
      params: {
        kindLabel: 'phiếu xăng dầu',
        code: 'TCNB-HN-0001',
        amount: 1250000,
      },
      metadata: { reviewId: 3 },
    });
    // Tên đã có trong actor: không cần đọc bảng user.
    expect(f.findMany).not.toHaveBeenCalled();
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.rows()).toEqual([
      {
        actionType: 'POST',
        actionCode: 'FIN_ENTRY_CREATE',
        category: 'internal_finance',
        severity: 'info',
        entityType: 'internal_finance_entries',
        entityId: '12',
        entityCode: 'TCNB-HN-0001',
        branchId: 6,
        message: 'Tạo phiếu xăng dầu TCNB-HN-0001 – 1.250.000 đ',
        messageTemplate: 'FIN_ENTRY_CREATE',
        messageParams: {
          kindLabel: 'phiếu xăng dầu',
          code: 'TCNB-HN-0001',
          amount: 1250000,
        },
        changes: undefined,
        snapshot: undefined,
        metadata: {
          reviewId: 3,
          actorKind: 'USER',
          trigger: 'http',
          onBehalfOfUserId: null,
        },
        requestId: 'op-1',
        userId: 5,
        userName: 'Nguyễn An',
      },
    ]);
  });

  it('writes a bulk operation with ONE user lookup and ONE createMany', async () => {
    const f = fakeDb(USERS);
    const opId = 'op-bulk';
    const entries: FinanceAuditEntry[] = [
      {
        action: 'FIN_ENTRY_CHECK',
        entityId: 1,
        entityCode: 'TCNB-1',
        actor: auditActor.user(5, 'http', opId),
        params: { roleLabel: 'Kế toán kho', code: 'TCNB-1' },
      },
      {
        action: 'FIN_ENTRY_CHECK',
        entityId: 2,
        entityCode: 'TCNB-2',
        actor: auditActor.user(9, 'http', opId),
        params: { roleLabel: 'Kế toán kho', code: 'TCNB-2' },
      },
      {
        action: 'FIN_APPROVAL_CREATE',
        entityId: 40,
        actor: auditActor.system('LARK', 'lark-webhook', 11, opId),
        params: { kindLabel: 'thu quỹ', code: 'PT-1' },
      },
      {
        action: 'FIN_FUND_CLOSING_INVALIDATE',
        entityId: 7,
        actor: auditActor.system('CRON', 'cron:reconcilePending', null, opId),
        params: { branch: 'Kho HN', date: '05/10/2026', cause: 'hủy dòng quỹ' },
      },
      {
        action: 'FIN_SCRIPT_RUN',
        entityId: 'import-office-ledger',
        actor: auditActor.script('import-office-ledger', 5, opId),
        params: { name: 'import-office-ledger', summary: '3 dòng' },
      },
    ];
    await service.write(f.db, entries);

    expect(f.findMany).toHaveBeenCalledTimes(1);
    expect(
      [...f.findMany.mock.calls[0][0].where.id.in].sort((a, b) => a - b),
    ).toEqual([5, 9, 11]);
    expect(f.createMany).toHaveBeenCalledTimes(1);
    const rows = f.rows();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.requestId)).toEqual(Array(5).fill(opId));
    expect(rows.map((row) => row.userName)).toEqual([
      'Nguyễn An',
      'lan@example.test',
      'Hệ thống (Lark Approval)',
      'Hệ thống (tự động)',
      'Script import-office-ledger',
    ]);
    // entityType mặc định theo catalog.
    expect(rows.map((row) => row.entityType)).toEqual([
      'internal_finance_entries',
      'internal_finance_entries',
      'approval_requests',
      'internal_fund_daily_closings',
      'finance_scripts',
    ]);
    expect(rows[2].userId).toBe(1);
    expect(rows[2].metadata).toEqual({
      actorKind: 'LARK',
      trigger: 'lark-webhook',
      onBehalfOfUserId: 11,
      onBehalfOfUserName: 'Trần Bình',
    });
    expect(rows[3].message).toBe(
      'Chốt sổ Kho HN ngày 05/10/2026 cần đối soát lại (hủy dòng quỹ)',
    );
    expect(rows[4]).toMatchObject({
      actionType: 'POST',
      severity: 'critical',
      userId: 5,
      message: 'Chạy script import-office-ledger --apply: 3 dòng',
    });
  });

  it('renders missing params as empty text and maps cancels to DELETE', async () => {
    const f = fakeDb(USERS);
    await service.write(f.db, [
      {
        action: 'FIN_ENTRY_UPDATE',
        entityId: 3,
        actor: auditActor.user({ id: 5, name: 'An' }),
        params: { kindLabel: 'phiếu chi kho', code: 'TCNB-3' },
      },
      {
        action: 'FIN_FUND_TXN_CANCEL',
        entityId: 8,
        actor: auditActor.user({ id: 5, name: 'An' }),
        params: { code: 'QF-CHI-1', amount: '125000.00', reasonSuffix: '' },
      },
    ]);
    const [update, cancel] = f.rows();
    expect(update.message).toBe('Sửa phiếu chi kho TCNB-3');
    expect(update.actionType).toBe('PUT');
    expect(cancel.message).toBe('Hủy dòng quỹ QF-CHI-1 125.000 đ');
    expect(cancel).toMatchObject({ actionType: 'DELETE', severity: 'warning' });
  });

  it('sanitizes snapshot/metadata JSON and names user-id changes', async () => {
    const f = fakeDb(USERS);
    const long = 'x'.repeat(2500);
    await service.write(f.db, {
      action: 'FIN_ENTRY_UPDATE',
      entityId: 4,
      actor: auditActor.user({ id: 5, name: 'An' }),
      params: { kindLabel: 'phiếu chi kho', code: 'TCNB-4' },
      changes: service.diff(
        FINANCE_AUDIT_ENTITY.ENTRY,
        { payerId: 9, amount: new Prisma.Decimal('100') },
        { payerId: 11, amount: 100 },
      ),
      snapshot: {
        lines: [{ label: 'Số tiền', value: '100 đ' }],
        amount: new Prisma.Decimal('125000.50'),
        at: new Date('2026-10-05T03:00:00.000Z'),
        big: BigInt(42),
        skip: undefined,
        long,
      },
      metadata: {
        removedAttachments: [{ fileName: 'a.jpg', size: undefined }],
      },
    });
    // Tên người dùng trong changes lấy cùng một lần findMany (id 9 và 11).
    expect(f.findMany).toHaveBeenCalledTimes(1);
    const [row] = f.rows();
    expect(row.changes).toEqual([
      {
        field: 'payerId',
        label: 'Người chi',
        from: 'lan@example.test',
        to: 'Trần Bình',
        type: 'field_changed',
        detail: { from: 9, to: 11 },
      },
    ]);
    const snapshot = row.snapshot as Record<string, unknown>;
    expect(snapshot.amount).toBe(125000.5);
    expect(snapshot.at).toBe('2026-10-05T03:00:00.000Z');
    expect(snapshot.big).toBe('42');
    expect('skip' in snapshot).toBe(false);
    expect((snapshot.long as string).length).toBe(2000);
    expect(row.metadata).toMatchObject({
      removedAttachments: [{ fileName: 'a.jpg' }],
    });
  });

  it('shows customer and invoice codes instead of raw ids', async () => {
    const f = fakeDb(USERS);
    const customerFind = jest.fn((args: FindManyArgs) =>
      Promise.resolve(
        [
          { id: 55, code: 'KH55', name: 'Cửa hàng A' },
          { id: 78, code: 'KH78', name: 'Cửa hàng B' },
        ].filter((row) => args.where.id.in.includes(row.id)),
      ),
    );
    const invoiceFind = jest.fn((args: FindManyArgs) =>
      Promise.resolve(
        [{ id: 8812, code: 'HD8812' }].filter((row) =>
          args.where.id.in.includes(row.id),
        ),
      ),
    );
    const db = {
      ...(f.db as object),
      customer: { findMany: customerFind },
      invoice: { findMany: invoiceFind },
    } as unknown as FinanceAuditDb;
    await service.write(db, {
      action: 'FIN_ENTRY_UPDATE',
      entityId: 4,
      actor: auditActor.user({ id: 5, name: 'An' }),
      params: { kindLabel: 'phiếu thu tiền mặt', code: 'TCNB-4' },
      changes: [
        ...service.diff(
          FINANCE_AUDIT_ENTITY.ENTRY,
          { customerId: 55, customerIds: [55, 99] },
          { customerId: 78, customerIds: [78, 55] },
        ),
        {
          field: 'invoiceLinks',
          label: 'Hóa đơn',
          from: '—',
          to: '#8812',
          type: 'item_added',
          detail: { invoiceId: 8812 },
        },
        {
          field: 'invoiceLinks',
          label: 'Hóa đơn',
          from: '#8800',
          to: '—',
          type: 'item_removed',
          detail: { invoiceId: 8800 },
        },
      ],
    });
    expect(customerFind).toHaveBeenCalledTimes(1);
    expect(customerFind.mock.calls[0][0].where.id.in.sort()).toEqual([
      55, 78, 99,
    ]);
    expect(invoiceFind).toHaveBeenCalledTimes(1);
    const [row] = f.rows();
    expect(
      (row.changes as Array<Record<string, unknown>>).map(
        ({ field, from, to }) => [field, from, to],
      ),
    ).toEqual([
      ['customerId', 'KH55 – Cửa hàng A', 'KH78 – Cửa hàng B'],
      [
        'customerIds',
        'KH55 – Cửa hàng A, #99',
        'KH78 – Cửa hàng B, KH55 – Cửa hàng A',
      ],
      ['invoiceLinks', '—', 'HD8812'],
      // Không tìm thấy hóa đơn: giữ "#id".
      ['invoiceLinks', '#8800', '—'],
    ]);
    expect((row.changes as Array<Record<string, unknown>>)[2].detail).toEqual({
      invoiceId: 8812,
      invoiceCode: 'HD8812',
    });
  });

  it('keeps "#id" when the client has no customer / invoice model', async () => {
    const f = fakeDb(USERS);
    await service.write(f.db, {
      action: 'FIN_ENTRY_UPDATE',
      entityId: 4,
      actor: auditActor.user({ id: 5, name: 'An' }),
      params: { kindLabel: 'phiếu', code: 'TCNB-4' },
      changes: service.diff(
        FINANCE_AUDIT_ENTITY.ENTRY,
        { customerId: 55 },
        { customerId: 78 },
      ),
    });
    expect(f.findMany).not.toHaveBeenCalled();
    expect(f.rows()[0].changes).toEqual([
      expect.objectContaining({ from: '#55', to: '#78' }),
    ]);
  });

  it('falls back to the system user when userId is not a real id', async () => {
    process.env.FINANCE_AUDIT_SYSTEM_USER_ID = '42';
    const f = fakeDb(USERS);
    await service.write(f.db, {
      action: 'FIN_VPSG_RECORD',
      entityId: 'sepay-1',
      actor: { userId: Number.NaN, kind: 'SYSTEM', opId: 'op-x' },
      params: { amount: 500000, content: 'CK' },
    });
    expect(f.rows()[0]).toMatchObject({
      userId: 42,
      userName: 'Hệ thống (tự động)',
      message: 'Ghi vào quỹ VPSG 500.000 đ – CK',
      entityType: 'sepay_transactions',
    });
  });

  it('rejects unknown codes and never swallows DB errors', async () => {
    const f = fakeDb(USERS);
    await expect(
      service.write(f.db, {
        action: 'FIN_NOT_A_CODE' as never,
        entityId: 1,
        actor: auditActor.user({ id: 5, name: 'An' }),
      }),
    ).rejects.toThrow('FIN_NOT_A_CODE');
    expect(f.createMany).not.toHaveBeenCalled();

    f.createMany.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.write(f.db, {
        action: 'FIN_ENTRY_NOTE_ADD',
        entityId: 1,
        actor: auditActor.user({ id: 5, name: 'An' }),
        params: { code: 'TCNB-1', preview: 'xem lại' },
      }),
    ).rejects.toThrow('db down');
  });
});

describe('FinanceAuditService.diff', () => {
  const service = new FinanceAuditService();

  it('returns [] when only non-whitelisted or equal values differ', () => {
    const at = new Date('2026-10-05T00:00:00+07:00');
    expect(
      service.diff(
        FINANCE_AUDIT_ENTITY.ENTRY,
        {
          amount: new Prisma.Decimal('125000'),
          occurredAt: at,
          updatedAt: new Date(1),
          posManagedAt: new Date(1),
        },
        {
          amount: 125000,
          occurredAt: new Date(at.getTime()),
          updatedAt: new Date(2),
          posManagedAt: new Date(2),
        },
      ),
    ).toEqual([]);
  });

  it('uses display strings for from/to', () => {
    const changes = service.diff(
      FINANCE_AUDIT_ENTITY.ENTRY,
      {
        amount: new Prisma.Decimal('100000'),
        status: 'READY_FOR_WEEKLY_APPROVAL',
        description: null,
      },
      { amount: 150000, status: 'MANAGER_APPROVED', description: 'Đổ xăng' },
    );
    expect(
      changes.map(({ field, label, from, to }) => [field, label, from, to]),
    ).toEqual([
      ['amount', 'Số tiền', '100.000 đ', '150.000 đ'],
      ['description', 'Nội dung', '—', 'Đổ xăng'],
      ['status', 'Trạng thái', 'Đã gom tuần', 'Đã kiểm tra'],
    ]);
  });
});
