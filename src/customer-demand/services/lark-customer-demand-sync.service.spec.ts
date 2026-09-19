import { LarkCustomerDemandSyncService } from './lark-customer-demand-sync.service';

describe('LarkCustomerDemandSyncService', () => {
  let listRecords: jest.Mock;
  let batchGetRecords: jest.Mock;
  let prisma: any;
  let service: LarkCustomerDemandSyncService;

  beforeEach(() => {
    listRecords = jest.fn();
    batchGetRecords = jest.fn().mockResolvedValue({
      code: 0,
      data: { records: [] },
    });
    prisma = {
      customer: { findMany: jest.fn() },
      product: { findMany: jest.fn() },
      customerDemandMonth: { findMany: jest.fn() },
      customerDemandLarkRecord: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
        aggregate: jest.fn(),
      },
      customerDemand: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new LarkCustomerDemandSyncService(
      {
        bitable: {
          appTableRecord: {
            list: listRecords,
            batchGet: batchGetRecords,
          },
        },
      } as any,
      prisma,
      { create: jest.fn() } as any,
      { get: jest.fn() } as any,
    );
  });

  it('đọc đủ pagination với page_size 500', async () => {
    listRecords
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ record_id: 'rec-1' }],
          has_more: true,
          page_token: 'page-2',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ record_id: 'rec-2' }],
          has_more: false,
        },
      });

    const rows = await (service as any).fetchAllRecords('tbl-demand');

    expect(rows.map((row: any) => row.record_id)).toEqual(['rec-1', 'rec-2']);
    expect(listRecords).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: expect.objectContaining({ page_size: 500 }),
      }),
    );
    expect(listRecords.mock.calls[1][0].params.page_token).toBe('page-2');
  });

  it('map khách hàng bằng linked record và fallback alias mã khách', () => {
    const indexes = {
      customerByLark: new Map([
        ['rec-customer-linked', { id: 1, name: 'Khách linked' }],
      ]),
      customerByCode: new Map([['kh002616.1', { id: 2, name: 'Khách alias' }]]),
      productByLark: new Map([
        ['rec-product-linked', { id: 11, name: 'SP linked' }],
      ]),
      productByCode: new Map([['sp001', { id: 12, name: 'SP code' }]]),
    };

    const linked = (service as any).resolveRecord(
      {
        record_id: 'rec-linked',
        fields: {
          'Mã khách': 'KH-OTHER',
          'Tên Khách Hàng': [{ record_ids: ['rec-customer-linked'] }],
          'Mã hàng': 'SP-OTHER',
          'Mã và Tên Hàng': [{ record_ids: ['rec-product-linked'] }],
          'Đơn Vị Đặt': 'Đơn vị',
          'Số lượng': 10,
          'Thời Gian (yyyy/mm)': '2026-9',
          'Ghi Chú': 'linked',
        },
      },
      indexes,
    );
    expect(linked.customerId).toBe(1);
    expect(linked.productId).toBe(11);

    const fallback = (service as any).resolveRecord(
      {
        record_id: 'rec-fallback',
        fields: {
          'Mã khách': 'KH002616, KH002616.1',
          'Mã hàng': 'SP001',
          'Đơn Vị Đặt': 'Đơn vị',
          'Số lượng': 10,
          'Thời Gian (yyyy/mm)': '2026-9',
        },
      },
      indexes,
    );
    expect(fallback.customerId).toBe(2);
    expect(fallback.productId).toBe(12);
  });

  it('đọc mã từ bảng liên kết khi local chưa có larkRecordId', () => {
    const result = (service as any).resolveRecord(
      {
        record_id: 'rec-linked-code',
        fields: {
          'Tên Khách Hàng': [{ record_ids: ['rec-customer-linked'] }],
          'Mã và Tên Hàng': [{ record_ids: ['rec-product-linked'] }],
          'Đơn Vị Đặt': 'Đơn vị',
          'Số lượng': 10,
          'Thời Gian (yyyy/mm)': '2026-9',
        },
      },
      {
        customerByLark: new Map(),
        customerByCode: new Map([
          ['kh-from-lark', { id: 3, name: 'Khách từ bảng liên kết' }],
        ]),
        productByLark: new Map(),
        productByCode: new Map([
          ['sp-from-lark', { id: 13, name: 'SP từ bảng liên kết' }],
        ]),
        linkedCustomerByRecordId: new Map([
          [
            'rec-customer-linked',
            { code: 'KH-FROM-LARK', name: 'Khách từ bảng liên kết' },
          ],
        ]),
        linkedProductByRecordId: new Map([
          [
            'rec-product-linked',
            { code: 'SP-FROM-LARK', name: 'SP từ bảng liên kết' },
          ],
        ]),
      },
    );

    expect(result.customerId).toBe(3);
    expect(result.productId).toBe(13);
  });

  it('chuẩn hóa tháng 2026-9 thành 2026-09', () => {
    expect((service as any).normalizeMonth('2026-9')).toBe('2026-09');
    expect((service as any).normalizeMonth('2026/09')).toBe('2026-09');
    expect((service as any).normalizeMonth('2026-13')).toBeNull();
  });

  it('gộp dòng cùng khách/tháng/sản phẩm có cả BASE và CARTON', () => {
    const merged = (service as any).mergeResolvedRows([
      row({
        sourceRecordId: 'rec-base',
        unit: 'BASE',
        quantity: 10,
        quantityBase: 10,
      }),
      row({
        sourceRecordId: 'rec-carton',
        unit: 'CARTON',
        quantity: 2,
        quantityBase: 24,
        conversionValue: 12,
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      inputUnit: 'BASE',
      inputQuantity: 34,
      quantityBase: 34,
      conversionValue: 1,
      sourceRecordIds: ['rec-base', 'rec-carton'],
    });
  });

  it('preview nhận diện một dòng POS duy nhất để cập nhật', async () => {
    mockSingleLarkRecord();
    prisma.customerDemandMonth.findMany.mockResolvedValue([
      monthRow({ lineId: 301 }),
    ]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([]);

    const preview = await service.preview();

    expect(preview).toMatchObject({
      totalRecords: 1,
      validRecords: 1,
      updatedLines: 1,
      newLines: 0,
      demandsToCreate: 0,
      monthsToCreate: 0,
    });
  });

  it('preview đánh dấu conflict khi có nhiều dòng POS cùng khóa', async () => {
    mockSingleLarkRecord();
    prisma.customerDemandMonth.findMany.mockResolvedValue([
      monthRow({ demandId: 201, monthId: 101, lineId: 301 }),
      monthRow({ demandId: 202, monthId: 102, lineId: 302 }),
    ]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([]);

    const preview = await service.preview();

    expect(preview).toMatchObject({
      totalRecords: 1,
      validRecords: 0,
      conflictedRecords: 1,
      newLines: 0,
      updatedLines: 0,
    });
    expect(preview.issues[0]).toMatchObject({ code: 'LINE_CONFLICT' });
  });

  it('preview dự kiến tạo phiếu đồng bộ riêng khi POS chưa có dòng khớp', async () => {
    mockSingleLarkRecord();
    prisma.customerDemandMonth.findMany.mockResolvedValue([]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([]);

    const preview = await service.preview();

    expect(preview).toMatchObject({
      totalRecords: 1,
      validRecords: 1,
      newLines: 1,
      updatedLines: 0,
      demandsToCreate: 1,
      monthsToCreate: 1,
    });
  });

  it('persist dùng upsert để chạy lại không tạo thêm tháng/dòng', async () => {
    const state: {
      demandId: number | null;
      monthId: number | null;
      lineId: number | null;
    } = { demandId: null, monthId: null, lineId: null };
    const tx = {
      customerDemand: {
        findFirst: jest.fn(async () =>
          state.demandId ? { id: state.demandId } : null,
        ),
        create: jest.fn(async () => {
          state.demandId = 201;
          return { id: 201 };
        }),
        update: jest.fn(),
      },
      customerDemandMonth: {
        findUnique: jest.fn(async () =>
          state.monthId ? { id: state.monthId, status: 'CONFIRMED' } : null,
        ),
        create: jest.fn(async () => {
          state.monthId = 101;
          return { id: 101, status: 'CONFIRMED' };
        }),
        update: jest.fn(),
      },
      customerDemandLine: {
        upsert: jest.fn(async () => {
          state.lineId = 301;
          return { id: 301 };
        }),
        update: jest.fn(),
      },
      customerDemandLarkRecord: {
        upsert: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const raw = row({ sourceRecordId: 'rec-1' });
    const plan = {
      summary: {} as any,
      groups: [
        {
          customerId: 1,
          customerName: 'Khách OEM',
          month: '2026-09',
          productId: 11,
          productName: 'SP 1',
          inputUnit: 'BASE',
          inputQuantity: 10,
          quantityBase: 10,
          conversionValue: 1,
          note: null,
          sourceRecordIds: ['rec-1'],
          sourceModifiedAt: null,
          existingDemandId: null,
          existingMonthId: null,
          existingLineId: null,
          existingMonthStatus: null,
          syncDemandId: null,
          syncMonthId: null,
          syncMonthStatus: null,
          action: 'CREATE',
        },
      ],
      rawRows: [raw],
      rawById: new Map([['rec-1', raw]]),
      issues: [],
    };

    await (service as any).persistPlan(plan, 7, new Date());
    await (service as any).persistPlan(plan, 7, new Date());

    expect(tx.customerDemand.create).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandMonth.create).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandLine.upsert).toHaveBeenCalledTimes(2);
    expect(tx.customerDemandLarkRecord.upsert).toHaveBeenCalledTimes(2);
  });

  function mockSingleLarkRecord() {
    listRecords.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            record_id: 'rec-1',
            fields: {
              'Mã khách': 'KH001',
              'Mã hàng': 'SP001',
              'Đơn Vị Đặt': 'Đơn vị',
              'Số lượng': 10,
              'Thời Gian (yyyy/mm)': '2026-9',
            },
          },
        ],
        has_more: false,
      },
    });
    prisma.customer.findMany.mockResolvedValue([
      { id: 1, code: 'KH001', name: 'Khách OEM', larkRecordId: null },
    ]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: 11,
        code: 'SP001',
        name: 'Sản phẩm 1',
        conversionValue: 12,
        larkRecordId: null,
      },
    ]);
  }

  function row(overrides: Record<string, any>) {
    return {
      sourceRecordId: 'rec-1',
      sourceModifiedAt: null,
      rawFields: {},
      customerCode: 'KH001',
      customerId: 1,
      customerName: 'Khách OEM',
      productCode: 'SP001',
      productId: 11,
      productName: 'Sản phẩm 1',
      month: '2026-09',
      unit: 'BASE',
      quantity: 10,
      quantityBase: 10,
      conversionValue: 1,
      note: null,
      issue: null,
      ...overrides,
    };
  }

  function monthRow(input: {
    demandId?: number;
    monthId?: number;
    lineId?: number;
  }) {
    return {
      id: input.monthId ?? 100,
      demandId: input.demandId ?? 200,
      demandMonth: new Date('2026-09-01T00:00:00.000Z'),
      status: 'DRAFT',
      lines: [{ id: input.lineId ?? 300, productId: 11 }],
      demand: { customerId: 1 },
    };
  }
});
