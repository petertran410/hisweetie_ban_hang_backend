import { summarizeLarkInstance } from './approval-lifecycle.constants';
import { LarkApprovalMirrorService } from './lark-approval-mirror.service';

const voucher = (method: string, source: string, cashAmount?: number) => [
  { id: 'widget17321753417610001', type: 'radioV2', value: method },
  { id: 'widget17643292059530001', type: 'radioV2', value: source },
  { id: 'widget17321752802850001', type: 'amount', value: 500000 },
  { id: 'widget17321750170610001', type: 'input', value: 'Mua băng keo' },
  ...(cashAmount
    ? [{ id: 'widget17643300136400001', type: 'amount', value: cashAmount }]
    : []),
];
const approvedAt = new Date('2026-10-14T03:00:00Z');

describe('summarizeLarkInstance', () => {
  it('keeps a cash PHIẾU CHI from Kho HN in scope', () => {
    expect(
      summarizeLarkInstance(
        'PHIEU_CHI',
        voucher('Tiền Mặt', 'Tiền Mặt Kho HN'),
        approvedAt,
      ),
    ).toMatchObject({
      inScope: true,
      branchId: 6,
      direction: 'EXPENSE',
      cashAmount: 500000,
      occurredAt: approvedAt,
      description: 'Mua băng keo',
    });
  });

  it('shows but does not take in bank-transfer and office-fund vouchers', () => {
    expect(
      summarizeLarkInstance(
        'PHIEU_CHI',
        voucher('Chuyển Khoản', 'CHDT'),
        approvedAt,
      ),
    ).toMatchObject({
      inScope: false,
      branchId: null,
      skipReason: 'Không chi bằng tiền mặt quỹ nội bộ',
      amount: 500000,
    });
    // Văn phòng HN đã lên POS; Văn phòng HCM chưa.
    expect(
      summarizeLarkInstance(
        'PHIEU_CHI',
        voucher('Tiền Mặt', 'Tiền Mặt Văn Phòng HN'),
        approvedAt,
      ),
    ).toMatchObject({ inScope: true, branchId: 4, skipReason: null });
    expect(
      summarizeLarkInstance(
        'PHIEU_CHI',
        voucher('Tiền Mặt', 'Tiền Mặt Văn Phòng HCM'),
        approvedAt,
      ),
    ).toMatchObject({
      inScope: false,
      branchId: 7,
      skipReason: 'Chi từ quỹ văn phòng',
    });
  });

  it('reads a cash receipt into Kho SG as an in-scope receipt', () => {
    const pick = (id: string, key: string, value = 'chữ') => ({
      id,
      type: 'radioV2',
      value,
      option: { key },
    });
    const summary = summarizeLarkInstance(
      'PHIEU_THU',
      [
        pick('widget17321740179360001', 'm3qzoq6o-9zz1b70wu0s-0'),
        pick('widget17321728506550001', 'md9r0rqr-tlntv5zjg8-1', 'Tiền mặt'),
        pick('widget17730449889490001', 'mmix7h92-vnvw9s8fgxd-0', 'Kho SG'),
        { id: 'widget17321629138780001', type: 'amount', value: 200000 },
        {
          id: 'widget17321631178550001',
          type: 'date',
          value: '2026-10-13T17:00:00Z',
        },
      ],
      approvedAt,
    );
    expect(summary).toMatchObject({
      inScope: true,
      branchId: 1,
      direction: 'RECEIPT',
      amount: 200000,
    });
  });

  it('keeps a PHIẾU CHI KHO made on Lark for viewing only', () => {
    const summary = summarizeLarkInstance(
      'PHIEU_CHI_KHO_SG',
      [
        { id: 'widget17399388386300001', type: 'input', value: '42' },
        { id: 'widget17399508904720001', type: 'date', value: '2026-10-13' },
        { id: 'widget17399508961760001', type: 'date', value: '2026-10-19' },
        { id: 'widget17368415755750001', type: 'amount', value: 150000 },
        { id: 'widget17368416610880001', type: 'input', value: 'Tiền ship' },
      ],
      approvedAt,
    );
    expect(summary).toMatchObject({
      inScope: false,
      branchId: 1,
      amount: 150000,
      description: 'Tiền ship (2026-10-13 → 2026-10-19)',
      fundBranchIds: [],
    });
    expect(summary.occurredAt).toEqual(new Date('2026-10-13T00:00:00+07:00'));
  });

  it('lists the funds a voucher or transfer touches', () => {
    expect(
      summarizeLarkInstance(
        'PHIEU_CHI',
        voucher('Tiền Mặt', 'Tiền Mặt Văn Phòng HN'),
        approvedAt,
      ).fundBranchIds,
    ).toEqual([4]);
    const pick = (id: string, key: string) => ({
      id,
      type: 'radioV2',
      value: 'chữ',
      option: { key },
    });
    expect(
      summarizeLarkInstance(
        'PHIEU_THU',
        [
          pick('widget17863314165550001', 'msmnlqej-t6tk3qikgcm-0'),
          pick('widget17863314190270001', 'msmnlsb8-5t1nguy4lg2-0'),
          { id: 'widget17321629138780001', type: 'amount', value: 175000000 },
        ],
        approvedAt,
      ),
    ).toMatchObject({ inScope: false, fundBranchIds: [6, 4] });
  });
});

describe('LarkApprovalMirrorService.ensureEntry', () => {
  function setup(options: {
    request: Record<string, any>;
    mirror?: Record<string, any>;
    fundRow?: Record<string, any> | null;
    ledgerTwin?: Record<string, any> | null;
  }) {
    const entries: any[] = [];
    const mirror = {
      id: 3,
      instanceCode: 'INST-1',
      formKind: 'PHIEU_CHI',
      inScope: true,
      branchId: 6,
      direction: 'EXPENSE',
      amount: 500000,
      cashAmount: 500000,
      occurredAt: approvedAt,
      completedAt: approvedAt,
      description: 'Mua băng keo',
      requesterId: 9,
      entryId: null,
      approvalRequestId: null,
      ...options.mirror,
    };
    const fundRow =
      options.fundRow === undefined
        ? {
            id: 70,
            status: 'POSTED',
            entryId: null,
            branchId: 6,
            occurredAt: approvedAt,
            sourceKey: 'PAYMENT_VOUCHER:50',
          }
        : options.fundRow;
    const prisma: any = {
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 50,
          instanceCode: 'INST-1',
          clientUuid: 'LARK:INST-1',
          sourceType: 'LARK_PAYMENT_VOUCHER',
          status: 'APPROVED',
          completedAt: approvedAt,
          createdById: 9,
          ...options.request,
        }),
      },
      larkApprovalInstance: {
        findUnique: jest.fn().mockResolvedValue(mirror),
        update: jest.fn(async ({ data }: any) => Object.assign(mirror, data)),
      },
      internalFinanceEntry: {
        findUnique: jest.fn(
          async ({ where }: any) =>
            entries.find((row) => row.sourceKey === where.sourceKey) || null,
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: 900 + entries.length, ...data };
          entries.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            entries.find((row) => row.id === where.id),
            data,
          ),
        ),
      },
      internalFundTransaction: {
        findUnique: jest.fn(async ({ where }: any) =>
          fundRow && fundRow.sourceKey === where.sourceKey ? fundRow : null,
        ),
        update: jest.fn(async ({ data }: any) => Object.assign(fundRow!, data)),
        findFirst: jest.fn().mockResolvedValue(options.ledgerTwin ?? null),
      },
      internalFinanceCodeCounter: {
        upsert: jest.fn().mockResolvedValue({ nextNumber: 2 }),
      },
    };
    prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
    const ledger: any = {
      lock: jest.fn(),
      releaseCancelled: jest.fn(async (_tx: any, row: any) =>
        Object.assign(row, { status: 'CANCELLED', entryId: null }),
      ),
    };
    const service = new LarkApprovalMirrorService(prisma, {} as any, ledger, {
      nextCode: jest.fn().mockResolvedValue('TCNB-CHI-HN-20261014-000001'),
    } as any);
    return { service, prisma, entries, mirror, fundRow, ledger };
  }

  it('turns an approved cash voucher into one paid entry linked to its fund row', async () => {
    const f = setup({ request: {} });
    await f.service.ensureEntry(50);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({
      sourceType: 'LARK_APPROVAL',
      sourceKey: 'LARK_APPROVAL:INST-1',
      direction: 'EXPENSE',
      category: 'CASH_FUND_EXPENSE',
      branchId: 6,
      amount: 500000,
      status: 'POSTED',
      cashIssued: true,
      requiresEvidence: false,
      payerId: 9,
    });
    expect(f.entries[0].sourceSnapshot.larkLedgerRecorded).toBeUndefined();
    expect(f.fundRow!.entryId).toBe(900);
    expect(f.mirror.entryId).toBe(900);

    await f.service.ensureEntry(50);
    expect(f.entries).toHaveLength(1);
  });

  it('does not book the fund again for orders approved before the ledger cutoff', async () => {
    const before = new Date('2026-10-05T03:00:00Z');
    const f = setup({
      request: { completedAt: before },
      mirror: { completedAt: before, occurredAt: before },
      fundRow: null,
    });
    await f.service.ensureEntry(50);
    expect(f.entries[0].sourceSnapshot).toMatchObject({
      larkLedgerRecorded: true,
    });
    expect(f.prisma.internalFundTransaction.update).not.toHaveBeenCalled();
  });

  it('keeps office voucher details on the entry and uses the VPHN ledger cutoff', async () => {
    // Duyệt 20/10: sau mốc kho (14/10) nhưng trước mốc VPHN (01/11) → sổ Lark đã ghi.
    const approvedOct20 = new Date('2026-10-20T03:00:00Z');
    const form = [
      ...voucher(
        'Chuyển Khoản (Công Ty + Tiền Mặt)',
        'Tiền Mặt Văn Phòng HN',
        200000,
      ),
      {
        id: 'w-loai',
        name: 'Loại chi phí',
        type: 'radioV2',
        value: 'Mua hàng nội địa, CCDC, dịch vụ',
      },
      {
        id: 'w-khoan',
        name: 'Khoản mục chi phí',
        type: 'radioV2',
        value: 'Cước điện thoại di động',
      },
      {
        id: 'w-pb',
        name: 'Chi phí thuộc phòng ban',
        type: 'radioV2',
        value: 'Phòng Hành Chính - Nhân Sự',
      },
      { id: 'w-ncu', name: 'NCU', type: 'input', value: 'Viettel' },
      {
        id: 'w-ck',
        name: 'Số tiền chuyển khoản',
        type: 'amount',
        value: 300000,
      },
    ];
    const f = setup({
      request: {
        completedAt: approvedOct20,
        formSnapshot: { version: 'lark', form },
      },
      mirror: {
        branchId: 4,
        amount: 500000,
        cashAmount: 200000,
        cashSource: 'Tiền Mặt Văn Phòng HN',
        completedAt: approvedOct20,
        occurredAt: approvedOct20,
      },
      fundRow: null,
    });
    await f.service.ensureEntry(50);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({
      branchId: 4,
      amount: 200000,
      expenseItem: 'Cước điện thoại di động',
    });
    expect(f.entries[0].sourceSnapshot).toMatchObject({
      larkLedgerRecorded: true,
      cashSource: 'Tiền Mặt Văn Phòng HN',
      method: 'Chuyển Khoản (Công Ty + Tiền Mặt)',
      expenseType: 'Mua hàng nội địa, CCDC, dịch vụ',
      expenseItem: 'Cước điện thoại di động',
      department: 'Phòng Hành Chính - Nhân Sự',
      supplier: 'Viettel',
      totalAmount: 500000,
      cashAmount: 200000,
      transferAmount: 300000,
    });
    expect(f.prisma.internalFundTransaction.findFirst).not.toHaveBeenCalled();
  });

  it('cancels the entry and the receipt fund row when Lark revokes an approved receipt', async () => {
    const f = setup({
      request: { sourceType: 'INTERNAL_FUND_RECEIPT' },
      mirror: { direction: 'RECEIPT', formKind: 'PHIEU_THU' },
      fundRow: {
        id: 71,
        status: 'POSTED',
        entryId: null,
        branchId: 6,
        occurredAt: approvedAt,
        sourceKey: 'RECEIPT:50',
      },
    });
    await f.service.ensureEntry(50);
    expect(f.entries[0]).toMatchObject({
      direction: 'RECEIPT',
      category: 'CASH_FUND_RECEIPT',
      payerId: null,
    });
    f.prisma.approvalRequest.findUnique.mockResolvedValue({
      id: 50,
      instanceCode: 'INST-1',
      clientUuid: 'LARK:INST-1',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      status: 'REVERTED',
      createdById: 9,
    });
    await f.service.ensureEntry(50);
    expect(f.ledger.releaseCancelled).toHaveBeenCalledTimes(1);
    expect(f.entries[0]).toMatchObject({
      status: 'CANCELLED',
      cashIssued: false,
      cancelReason: 'Đơn bị thu hồi trên Lark Approval',
    });
  });

  it('does not add a paid row after the cutoff when its fund row was cancelled', async () => {
    const f = setup({
      request: {},
      fundRow: {
        id: 72,
        status: 'CANCELLED',
        entryId: null,
        branchId: 6,
        occurredAt: approvedAt,
        sourceKey: 'PAYMENT_VOUCHER:50',
      },
    });
    expect(await f.service.ensureEntry(50)).toBeNull();
    expect(f.entries).toHaveLength(0);
  });

  it('records an order already on the Lark Base ledger without booking the fund', async () => {
    const f = setup({ request: {}, fundRow: null, ledgerTwin: { id: 5 } });
    await f.service.ensureEntry(50);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0].sourceSnapshot).toMatchObject({
      larkLedgerRecorded: true,
    });
    expect(f.prisma.internalFundTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceType: 'LEDGER_HISTORY',
          transactionType: 'EXPENSE',
          amount: 500000,
        }),
      }),
    );
  });

  it('ignores POS-created requests and out-of-scope orders', async () => {
    const pos = setup({ request: { clientUuid: 'INTERNAL_FINANCE_WEEK:1' } });
    expect(await pos.service.ensureEntry(50)).toBeNull();
    const out = setup({ request: {}, mirror: { inScope: false } });
    expect(await out.service.ensureEntry(50)).toBeNull();
    expect(pos.entries).toHaveLength(0);
    expect(out.entries).toHaveLength(0);
  });
});

describe('LarkApprovalMirrorService.inspect', () => {
  it('flags a POS expense with the same fund, amount and close date', async () => {
    const prisma: any = {
      internalFinanceEntry: {
        findFirst: jest.fn().mockResolvedValue({ id: 44 }),
      },
    };
    const service = new LarkApprovalMirrorService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
    );
    const result = await service.inspect('PHIEU_CHI', {
      form: JSON.stringify(voucher('Tiền Mặt', 'Tiền Mặt Kho HN')),
      end_time: String(approvedAt.getTime()),
    });
    expect(result.summary.inScope).toBe(true);
    expect(result.suspectDuplicateOfId).toBe(44);
    expect(prisma.internalFinanceEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 6,
          amount: 500000,
          sourceType: { not: 'LARK_APPROVAL' },
        }),
      }),
    );
  });
});
