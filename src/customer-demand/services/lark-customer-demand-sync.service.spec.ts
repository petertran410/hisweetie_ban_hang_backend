import { LarkCustomerDemandSyncService } from './lark-customer-demand-sync.service';

describe('LarkCustomerDemandSyncService', () => {
  const SOURCE_CREATED_AT = new Date('2025-08-22T09:01:57.000Z');
  const SOURCE_UPDATED_AT = new Date('2025-12-23T07:35:59.000Z');
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
      customerDemandLine: { findMany: jest.fn() },
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

  it('đọc ngày hệ thống Lark từ timestamp và dự phòng từ field ISO', () => {
    const fromSystem = (service as any).resolveRecord({
      record_id: 'rec-dates',
      created_time: SOURCE_CREATED_AT.getTime(),
      last_modified_time: String(SOURCE_UPDATED_AT.getTime()),
      fields: {},
    });
    expect(fromSystem.sourceCreatedAt).toEqual(SOURCE_CREATED_AT);
    expect(fromSystem.sourceModifiedAt).toEqual(SOURCE_UPDATED_AT);

    const fromFields = (service as any).resolveRecord({
      record_id: 'rec-fallback-dates',
      fields: {
        'Ngày Tạo': '2025-08-22T16:01:57.000+07:00',
        'Ngày Cập Nhật': '2025-12-23T14:35:59.000+07:00',
      },
    });
    expect(fromFields.sourceCreatedAt).toEqual(SOURCE_CREATED_AT);
    expect(fromFields.sourceModifiedAt).toEqual(SOURCE_UPDATED_AT);
    expect((service as any).sourceDate('2025/08/22 16:01:57')).toEqual(
      SOURCE_CREATED_AT,
    );
  });

  it('giữ hai record cùng khách/tháng/sản phẩm thành hai dòng riêng', () => {
    const planned = (service as any).planResolvedRows([
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

    expect(planned).toHaveLength(2);
    expect(planned[0]).toMatchObject({
      inputUnit: 'BASE',
      inputQuantity: 10,
      sourceRecordIds: ['rec-base'],
    });
    expect(planned[1]).toMatchObject({
      inputUnit: 'CARTON',
      inputQuantity: 2,
      quantityBase: 24,
      sourceRecordIds: ['rec-carton'],
    });
  });

  it('preview không ghép record Lark mới vào dòng POS có cùng khóa', async () => {
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
      updatedLines: 0,
      newLines: 1,
      demandsToCreate: 1,
      monthsToCreate: 1,
    });
  });

  it('preview tạo dòng mới khi có nhiều dòng POS cùng khóa nhưng chưa map', async () => {
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
      validRecords: 1,
      conflictedRecords: 0,
      newLines: 1,
      updatedLines: 0,
    });
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

  it('preview báo record thiếu ngày nguồn và không tạo dòng POS', async () => {
    mockSingleLarkRecord();
    // Use the same mocked record shape without either automatic timestamp.
    listRecords.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            record_id: 'rec-missing-date',
            fields: {
              'Mã khách': 'KH001',
              'Mã hàng': 'SP001',
              'Đơn Vị Đặt': 'Đơn vị',
              'Số lượng': 10,
              'Thời Gian (yyyy/mm)': '2026-09',
            },
          },
        ],
        has_more: false,
      },
    });
    prisma.customerDemandMonth.findMany.mockResolvedValue([]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([]);

    const preview = await service.preview();

    expect(preview).toMatchObject({
      totalRecords: 1,
      validRecords: 0,
      invalidTimestampRecords: 1,
      newLines: 0,
    });
    expect(preview.issues[0].code).toBe('MISSING_SOURCE_TIMESTAMP');
  });

  it('record thiếu ngày nguồn không gỡ mapping của dòng đã đồng bộ', async () => {
    mockSingleLarkRecord();
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
              'Thời Gian (yyyy/mm)': '2026-09',
            },
          },
        ],
        has_more: false,
      },
    });
    prisma.customerDemandMonth.findMany.mockResolvedValue([
      monthRow({ lineId: 301 }),
    ]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([
      { sourceRecordId: 'rec-1', demandLineId: 301 },
    ]);
    const tx = {
      customerDemandLarkRecord: {
        upsert: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const plan = await (service as any).loadPlan();
    await (service as any).persistPlan(plan, 7, new Date());

    expect(tx.customerDemandLarkRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceRecordId: 'rec-1' },
        update: expect.not.objectContaining({ demandLineId: null }),
      }),
    );
  });

  it('preview giữ hai record trùng khách/tháng/SKU thành hai phiếu riêng', async () => {
    listRecords.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            record_id: 'rec-1',
            created_time: SOURCE_CREATED_AT.getTime(),
            last_modified_time: SOURCE_UPDATED_AT.getTime(),
            fields: {
              'Mã khách': 'KH001',
              'Mã hàng': 'SP001',
              'Đơn Vị Đặt': 'Đơn vị',
              'Số lượng': 10,
              'Thời Gian (yyyy/mm)': '2026-09',
            },
          },
          {
            record_id: 'rec-2',
            created_time: SOURCE_CREATED_AT.getTime() + 1000,
            last_modified_time: SOURCE_UPDATED_AT.getTime() + 1000,
            fields: {
              'Mã khách': 'KH001',
              'Mã hàng': 'SP001',
              'Đơn Vị Đặt': 'Đơn vị',
              'Số lượng': 7,
              'Thời Gian (yyyy/mm)': '2026-09',
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
    prisma.customerDemandMonth.findMany.mockResolvedValue([]);
    prisma.customerDemand.findMany.mockResolvedValue([]);
    prisma.customerDemandLarkRecord.findMany.mockResolvedValue([]);

    const preview = await service.preview();

    expect(preview).toMatchObject({
      totalRecords: 2,
      validRecords: 2,
      newLines: 2,
      aggregatedRows: 2,
      demandsToCreate: 2,
      monthsToCreate: 2,
    });
  });

  it('chặn sync khi còn phiếu Lark cũ chứa nhiều record', async () => {
    jest.spyOn(service as any, 'loadPlan').mockResolvedValue({
      summary: {
        totalRecords: 2,
        legacyVouchers: 1,
      },
      groups: [],
      rawRows: [],
      rawById: new Map(),
      issues: [],
    });

    await expect(service.sync(7)).rejects.toThrow(
      'hãy tách phiếu cũ trước khi đồng bộ',
    );
  });

  it('preview nhận diện một phiếu Lark cũ có nhiều record để tách', async () => {
    const nextCreatedAt = new Date(SOURCE_CREATED_AT.getTime() + 1000);
    const nextUpdatedAt = new Date(SOURCE_UPDATED_AT.getTime() + 1000);
    prisma.customerDemand.findMany.mockResolvedValue([
      legacyVoucher({
        rows: [
          legacyRow(301, 'rec-base', SOURCE_CREATED_AT, SOURCE_UPDATED_AT, 10),
          legacyRow(302, 'rec-carton', nextCreatedAt, nextUpdatedAt, 24),
        ],
      }),
    ]);

    const preview = await service.previewVoucherSplit();

    expect(preview).toMatchObject({
      totalMappedRecords: 2,
      totalLarkVouchers: 1,
      vouchersToSplit: 1,
      vouchersToCreate: 1,
      linesToMove: 1,
      readyVouchers: 1,
      conflictedVouchers: 0,
      quantityBaseBefore: 34,
      quantityBaseAfter: 34,
    });
  });

  it('không tự tách phiếu Lark đã có lịch sử chỉnh sửa tháng', async () => {
    prisma.customerDemand.findMany.mockResolvedValue([
      legacyVoucher({
        changeLogs: [{ id: 901 }],
        rows: [
          legacyRow(301, 'rec-base', SOURCE_CREATED_AT, SOURCE_UPDATED_AT, 10),
          legacyRow(
            302,
            'rec-carton',
            new Date(SOURCE_CREATED_AT.getTime() + 1000),
            new Date(SOURCE_UPDATED_AT.getTime() + 1000),
            24,
          ),
        ],
      }),
    ]);

    const preview = await service.previewVoucherSplit();

    expect(preview).toMatchObject({
      vouchersToSplit: 1,
      readyVouchers: 0,
      conflictedVouchers: 1,
    });
    expect(preview.issues[0].message).toContain('lịch sử chỉnh sửa');
  });

  it('tách phiếu cũ bằng cách chuyển dòng hiện có sang phiếu riêng', async () => {
    const nextCreatedAt = new Date(SOURCE_CREATED_AT.getTime() + 1000);
    const nextUpdatedAt = new Date(SOURCE_UPDATED_AT.getTime() + 1000);
    const tx = {
      customerDemand: {
        findUnique: jest.fn().mockResolvedValue(
          legacyVoucher({
            rows: [
              legacyRow(
                301,
                'rec-base',
                SOURCE_CREATED_AT,
                SOURCE_UPDATED_AT,
                10,
              ),
              legacyRow(302, 'rec-carton', nextCreatedAt, nextUpdatedAt, 24),
            ],
          }),
        ),
        create: jest.fn().mockResolvedValue({ id: 202 }),
        update: jest.fn(),
      },
      customerDemandMonth: {
        create: jest.fn().mockResolvedValue({ id: 102 }),
        update: jest.fn(),
      },
      customerDemandLine: { update: jest.fn() },
      customerDemandLarkRecord: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const result = await (service as any).persistVoucherSplit(
      {
        ready: [
          {
            demandId: 201,
            demandMonthId: 101,
            customerId: 1,
            customerName: 'Khách OEM',
            month: '2026-09',
            createdBy: 3,
            updatedBy: 4,
            demandNote: null,
            monthStatus: 'CONFIRMED',
            monthNote: 'Đồng bộ từ LarkBase',
            approvedAt: SOURCE_UPDATED_AT,
            approvedBy: 3,
            cancelledAt: null,
            cancelledBy: null,
            rows: [
              {
                lineId: 301,
                sourceRecordId: 'rec-base',
                sourceCreatedAt: SOURCE_CREATED_AT,
                sourceModifiedAt: SOURCE_UPDATED_AT,
                quantityBase: 10,
              },
              {
                lineId: 302,
                sourceRecordId: 'rec-carton',
                sourceCreatedAt: nextCreatedAt,
                sourceModifiedAt: nextUpdatedAt,
                quantityBase: 24,
              },
            ],
            quantityBase: 34,
          },
        ],
      },
      new Date(),
    );

    expect(result).toEqual({
      vouchersSplit: 1,
      vouchersCreated: 1,
      linesMoved: 1,
    });
    expect(tx.customerDemandLine.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: expect.objectContaining({
        sourceCreatedAt: SOURCE_CREATED_AT,
        sourceUpdatedAt: SOURCE_UPDATED_AT,
      }),
    });
    expect(tx.customerDemandLine.update).toHaveBeenCalledWith({
      where: { id: 302 },
      data: expect.objectContaining({
        demandMonthId: 102,
        sourceCreatedAt: nextCreatedAt,
        sourceUpdatedAt: nextUpdatedAt,
      }),
    });
    expect(tx.customerDemand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        syncKey: 'lark:rec-carton',
        createdBy: 3,
        updatedBy: 4,
        createdAt: nextCreatedAt,
        updatedAt: nextUpdatedAt,
      }),
      select: { id: true },
    });
  });

  it('persist cập nhật dòng đã map và không tạo lại dòng', async () => {
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
        findMany: jest.fn(async () =>
          state.demandId ? [{ id: state.demandId }] : [],
        ),
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
        create: jest.fn(async () => {
          state.lineId = 301;
          return { id: 301 };
        }),
        update: jest.fn(async () => ({ id: state.lineId ?? 301 })),
        aggregate: jest.fn(async () => ({
          _max: {
            sourceCreatedAt: SOURCE_CREATED_AT,
            sourceUpdatedAt: SOURCE_UPDATED_AT,
          },
        })),
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
          sourceCreatedAt: SOURCE_CREATED_AT,
          sourceModifiedAt: SOURCE_UPDATED_AT,
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
    const secondPlanGroup = plan.groups[0] as any;
    secondPlanGroup.existingDemandId = 201;
    secondPlanGroup.existingMonthId = 101;
    secondPlanGroup.existingLineId = 301;
    secondPlanGroup.existingMonthStatus = 'CONFIRMED';
    secondPlanGroup.action = 'UPDATE';
    await (service as any).persistPlan(plan, 7, new Date());

    expect(tx.customerDemand.create).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandMonth.create).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandLine.create).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandLine.update).toHaveBeenCalledTimes(1);
    expect(tx.customerDemandLine.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: expect.objectContaining({
        createdAt: SOURCE_CREATED_AT,
        updatedAt: SOURCE_UPDATED_AT,
      }),
    });
    expect(tx.customerDemandLarkRecord.upsert).toHaveBeenCalledTimes(2);
    expect(tx.customerDemandLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdAt: SOURCE_CREATED_AT,
        updatedAt: SOURCE_UPDATED_AT,
        sourceCreatedAt: SOURCE_CREATED_AT,
        sourceUpdatedAt: SOURCE_UPDATED_AT,
      }),
    });
    expect(tx.customerDemand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        syncKey: 'lark:rec-1',
        createdAt: SOURCE_CREATED_AT,
        updatedAt: SOURCE_UPDATED_AT,
      }),
      select: { id: true },
    });
    expect(tx.customerDemand.update).toHaveBeenCalledWith({
      where: { id: 201 },
      data: {
        syncKey: 'lark:rec-1',
        updatedBy: 7,
        createdAt: SOURCE_CREATED_AT,
        updatedAt: SOURCE_UPDATED_AT,
      },
    });
  });

  function mockSingleLarkRecord() {
    listRecords.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            record_id: 'rec-1',
            created_time: SOURCE_CREATED_AT.getTime(),
            last_modified_time: SOURCE_UPDATED_AT.getTime(),
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
      sourceCreatedAt: SOURCE_CREATED_AT,
      sourceModifiedAt: SOURCE_UPDATED_AT,
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

  function legacyRow(
    lineId: number,
    sourceRecordId: string,
    sourceCreatedAt: Date,
    sourceModifiedAt: Date,
    quantityBase: number,
  ) {
    return {
      id: lineId,
      quantityBase,
      larkRecords: [
        {
          sourceRecordId,
          sourceCreatedAt,
          sourceModifiedAt,
          status: 'SYNCED',
        },
      ],
    };
  }

  function legacyVoucher({
    rows,
    changeLogs = [],
  }: {
    rows: Array<ReturnType<typeof legacyRow>>;
    changeLogs?: Array<{ id: number }>;
  }) {
    return {
      id: 201,
      customerId: 1,
      sourceSystem: 'LARK',
      createdBy: 3,
      updatedBy: 4,
      note: null,
      customer: { name: 'Khách OEM' },
      months: [
        {
          id: 101,
          demandMonth: new Date('2026-09-01T00:00:00.000Z'),
          status: 'CONFIRMED',
          note: 'Đồng bộ từ LarkBase',
          approvedAt: SOURCE_UPDATED_AT,
          approvedBy: 3,
          cancelledAt: null,
          cancelledBy: null,
          changeLogs,
          lines: rows,
        },
      ],
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
