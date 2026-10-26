import {
  NO_COPY_REASON,
  cancelVehicleNoCopy,
  compareExpenses,
  mapLarkExpense,
  type LarkExpenseRow,
  type PosExpenseRow,
} from './warehouse-expense-compare';

const TABLE = 'tblSG';
const lark = (
  recordId: string,
  amount: number,
  patch: Partial<LarkExpenseRow> = {},
): LarkExpenseRow => ({
  recordId,
  day: '2026-03-01',
  amount,
  department: 'Kho Sài Gòn',
  content: '',
  note: '',
  slipCode: '',
  ...patch,
});
const pos = (
  id: number,
  amount: number,
  patch: Partial<PosExpenseRow> = {},
): PosExpenseRow => ({
  id,
  code: `P${id}`,
  occurredAt: new Date('2026-03-01T03:00:00Z'),
  amount,
  status: 'MANAGER_APPROVED',
  sourceType: 'LARK_IMPORT',
  sourceKey: null,
  category: 'OTHER_EXPENSE',
  description: null,
  note: null,
  cancelReason: null,
  ...patch,
});
const key = (record: string) => `LARK:base:${TABLE}:${record}`;

describe('compareExpenses', () => {
  it('splits the POS − Lark difference into groups that add up exactly', () => {
    const larkRows = [
      lark('r1', 100), // khớp
      lark('r2', 200), // sửa tiền trên Lark
      lark('r3', 300), // chưa nhập
      lark('r4', 400, { department: 'Văn Phòng Sài Gòn' }),
      lark('r5', 500), // đã hủy trên POS (bản sao)
      lark('r6', 600), // POS xếp ngày khác
      lark('r7', 700, { day: '2025-12-31' }), // Lark ngoài khoảng, POS trong khoảng
    ];
    const byRecord = [
      pos(1, 100, { sourceKey: key('r1') }),
      pos(2, 250, { sourceKey: key('r2') }),
      pos(5, 500, { sourceKey: key('r5'), status: 'CANCELLED' }),
      pos(6, 600, {
        sourceKey: key('r6'),
        occurredAt: new Date('2026-04-30T18:00:00Z'),
      }),
      pos(7, 700, { sourceKey: key('r7') }),
      pos(8, 80, { sourceKey: key('r-deleted') }),
    ];
    const posInRange = [
      byRecord[0],
      byRecord[1],
      byRecord[4],
      byRecord[5],
      pos(9, 500, { category: 'VEHICLE_CARE' }), // phiếu xe nhập đôi
      pos(10, 50, { sourceType: 'PACKING_SLIP', category: 'DELIVERY_FEE' }),
      pos(11, 30, { sourceType: 'MANUAL_EXPENSE' }),
    ];
    const result = compareExpenses({
      tableId: TABLE,
      department: 'Kho Sài Gòn',
      from: '2026-01-01',
      to: '2026-03-31',
      larkRows,
      posInRange,
      posByRecord: new Map(
        byRecord.map((row) => [row.sourceKey!.split(':')[3], row]),
      ),
    });
    const sum = [...result.byGroup.values()].reduce((s, g) => s + g.delta, 0);
    expect(sum).toBe(result.posTotal - result.larkTotal);
    const delta = (group: string) => result.byGroup.get(group as any)?.delta;
    expect(delta('amountDiff')).toBe(50);
    expect(delta('larkNotImported')).toBe(-300);
    expect(delta('larkOtherDepartment')).toBe(-400);
    expect(delta('larkCancelledOnPos')).toBe(-500);
    expect(delta('dateShift')).toBe(-600 + 700);
    expect(delta('posDeletedOnLark')).toBe(80);
    expect(delta('posVehicleNoCopy')).toBe(500);
    expect(delta('posPackingSlip')).toBe(50);
    expect(delta('posCreated')).toBe(30);
    // Lark trong khoảng: r1–r6 = 2.100; bỏ dòng phòng ban khác (400).
    expect(result.larkTotal).toBe(2100);
    expect(result.larkDepartment).toBe(1700);
  });

  it('pairs Lark copies skipped at import with their vehicle entries', () => {
    const at = new Date('2026-03-09T10:26:52.000Z');
    const result = compareExpenses({
      tableId: TABLE,
      department: 'Kho Sài Gòn',
      from: '2026-01-01',
      to: '2026-03-31',
      larkRows: [
        lark('c1', 650000, { day: '2026-03-09', ms: at.getTime() }),
        lark('c2', 80000, { day: '2026-03-02' }),
        lark('c3', 99000, { day: '2026-03-03' }), // chưa nhập thật
      ],
      posInRange: [
        pos(1, 650000, { category: 'FUEL', occurredAt: at }),
        pos(2, 80000, {
          category: 'VEHICLE_CARE',
          occurredAt: new Date('2026-03-02T04:00:00Z'),
        }),
        pos(3, 120000, { category: 'FUEL' }), // không có dòng Lark
      ],
      posByRecord: new Map(),
    });
    const delta = (group: string) => result.byGroup.get(group as any);
    expect(delta('vehicleCopySkipped')).toEqual({ count: 2, delta: 0 });
    expect(delta('larkNotImported')).toEqual({ count: 1, delta: -99000 });
    expect(delta('posVehicleNoCopy')).toEqual({ count: 1, delta: 120000 });
    const sum = [...result.byGroup.values()].reduce((s, g) => s + g.delta, 0);
    expect(sum).toBe(result.posTotal - result.larkTotal);
  });

  it('nets copies merged by dedupe and pairs same-day copies by plate', () => {
    const day = new Date('2026-02-07T03:00:00Z');
    const result = compareExpenses({
      tableId: TABLE,
      department: 'Kho Sài Gòn',
      from: '2026-01-01',
      to: '2026-03-31',
      larkRows: [
        lark('m1', 180000, { day: '2026-02-07' }),
        lark('p1', 50000, {
          day: '2026-02-07',
          note: '16H5 - 2366 (xe máy) - hùng',
        }),
        lark('p2', 50000, {
          day: '2026-02-07',
          note: '71H4 - 8700 (xe máy) - tùng',
        }),
      ],
      posInRange: [
        pos(10, 180000, {
          code: 'CSX-10',
          category: 'VEHICLE_CARE',
          occurredAt: day,
        }),
        pos(11, 50000, {
          category: 'FUEL',
          occurredAt: day,
          description: 'Xăng dầu - 71H4 - 8700 (xe máy)',
        }),
        pos(12, 50000, {
          category: 'FUEL',
          occurredAt: day,
          description: 'Xăng dầu - 16H5 - 2366 (xe máy)',
        }),
      ],
      posByRecord: new Map([
        [
          'm1',
          pos(1, 180000, {
            sourceKey: key('m1'),
            status: 'CANCELLED',
            cancelReason: 'Trùng với phiếu xe CSX-10 (dữ liệu chuyển từ Lark)',
          }),
        ],
      ]),
    });
    const group = (name: string) => result.byGroup.get(name as any);
    expect(group('vehicleCopyMerged')).toEqual({ count: 1, delta: 0 });
    expect(group('vehicleCopySkipped')).toEqual({ count: 2, delta: 0 });
    expect(group('posVehicleNoCopy')).toBeUndefined();
    expect(result.lines.find((l) => l.lark?.recordId === 'p1')?.pos?.id).toBe(
      12,
    );
    expect(result.posTotal - result.larkTotal).toBe(0);
  });

  it('maps a Lark record', () => {
    expect(
      mapLarkExpense({
        recordId: 'r1',
        fields: {
          'NĂM/THÁNG/NGÀY': 1773052012000,
          'THÀNH TIỀN': { type: 2, value: [650000] },
          'Phòng ban': 'Kho Sài Gòn',
          'NỘI DUNG': [{ text: 'Dầu xe', type: 'text' }],
          'GHI CHÚ': [{ text: 'Xăng - 29D - 233.19', type: 'text' }],
        },
      }),
    ).toEqual({
      recordId: 'r1',
      day: '2026-03-09',
      ms: 1773052012000,
      amount: 650000,
      department: 'Kho Sài Gòn',
      content: 'Dầu xe',
      note: 'Xăng - 29D - 233.19',
      slipCode: '',
    });
  });
});

describe('cancelVehicleNoCopy', () => {
  it('cancels Lark vehicle entries without a copy, skipping fund postings', async () => {
    const entryUpdate = jest.fn();
    const batchUpdate = jest.fn();
    const reviewCreate = jest.fn();
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 1,
        code: 'CSX-1',
        branchId: 1,
        amount: 7236000,
        cashFlowId: null,
        weeklyBatchId: 5,
        weeklyBatch: { status: 'APPROVED' },
        fundTransaction: null,
      },
      {
        id: 2,
        code: 'XD-2',
        branchId: 1,
        amount: 30000,
        cashFlowId: null,
        weeklyBatchId: 6,
        weeklyBatch: { status: 'READY' },
        fundTransaction: null,
      },
      {
        id: 3,
        code: 'XD-3',
        branchId: 1,
        amount: 50000,
        cashFlowId: null,
        weeklyBatchId: null,
        weeklyBatch: null,
        fundTransaction: { code: 'QF-1', status: 'POSTED' },
      },
    ]);
    const tx = {
      internalFinanceEntry: { findMany, update: entryUpdate },
      internalFinanceWeeklyBatch: { update: batchUpdate },
      internalFinanceReview: { create: reviewCreate },
      $executeRaw: jest.fn(),
    };
    const prisma = { $transaction: (fn: any) => fn(tx) } as any;
    const result = await cancelVehicleNoCopy(prisma, [1, 2, 3], 7);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      sourceType: 'LARK_IMPORT',
      category: { in: ['FUEL', 'VEHICLE_CARE'] },
    });
    expect(result).toEqual({
      cancelled: ['CSX-1', 'XD-2'],
      skipped: [{ code: 'XD-3', reason: 'Có giao dịch quỹ QF-1' }],
    });
    // Tuần chưa gửi Lark thì trừ tổng; tuần đã duyệt giữ tổng của Lark.
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate.mock.calls[0][0]).toEqual({
      where: { id: 6 },
      data: { totalAmount: { decrement: 30000 } },
    });
    expect(entryUpdate.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: NO_COPY_REASON,
      cancelledBy: 7,
      weeklyBatchId: null,
      cashIssued: false,
    });
  });
});
