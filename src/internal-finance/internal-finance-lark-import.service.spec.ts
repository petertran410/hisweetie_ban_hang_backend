import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';

describe('InternalFinanceLarkImportService', () => {
  const tables = [
    { tableId: 'hn', name: 'Tổng hợp phiếu chi kho HN' },
    { tableId: 'rollup', name: 'Giao Dịch Tiền Mặt - Kho' },
    { tableId: 'receipt', name: 'Phiếu thu' },
  ];

  const makeService = (overrides: any = {}) => {
    const storedEntries = new Map<number, any>();
    let nextId = 1;
    const prisma: any = {
      internalFinanceEntry: {
        findMany: jest.fn(async (args: any = {}) => {
          const where = args?.where || {};
          if (where.id?.in) {
            return where.id.in
              .map((id: number) => storedEntries.get(id))
              .filter(Boolean);
          }
          if (where.sourceKey?.in) {
            return [...storedEntries.values()].filter((row) =>
              where.sourceKey.in.includes(row.sourceKey),
            );
          }
          return [];
        }),
        create: jest.fn(async (args: any) => {
          const row = { ...args.data, id: nextId++ };
          storedEntries.set(row.id, row);
          return row;
        }),
        findUnique: jest.fn(
          async (args: any) => storedEntries.get(args.where.id) || null,
        ),
        update: jest.fn(async (args: any) => {
          const current = storedEntries.get(args.where.id) || {
            id: args.where.id,
          };
          const row = { ...current, ...args.data };
          storedEntries.set(args.where.id, row);
          return row;
        }),
      },
      internalFinanceAttachment: { create: jest.fn() },
      internalFundTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      packingSlip: { findMany: jest.fn().mockResolvedValue([]) },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlow: { create: jest.fn() },
      internalFinanceWeeklyBatch: { create: jest.fn() },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(async (args: any) => ({
          id: 31,
          label: args.create.label,
        })),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      ...overrides.prisma,
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const uploadService = {
      saveFile: jest.fn().mockResolvedValue({
        url: '/uploads/internal-finance/file.jpg',
        size: 12,
      }),
    };
    const lark = {
      getToken: jest.fn().mockResolvedValue('token'),
      listTables: jest.fn().mockResolvedValue(tables),
      listFieldNames: jest
        .fn()
        .mockResolvedValue(['Số tiền', 'Nội dung', 'Chứng từ']),
      forEachRecordPage: jest.fn(async (_base, tableId, _token, onPage) => {
        if (tableId !== 'hn') return 0;
        await onPage([
          {
            recordId: 'rec1',
            fields: {
              'Số tiền': 100000,
              'Nội dung': 'Phí Grab HD128738',
              'Chứng từ': [
                {
                  file_token: 'file1',
                  name: 'bill.jpg',
                  url: 'https://lark/file1',
                },
              ],
            },
          },
          { recordId: 'rec0', fields: { 'Số tiền': 0 } },
        ], {
          page: 1,
          pageRecords: 2,
          totalFetched: 2,
          hasMore: false,
        });
        return 2;
      }),
      download: jest.fn().mockResolvedValue(Buffer.from('file')),
      ...overrides.lark,
    };
    const codeService = {
      nextCode: jest.fn().mockResolvedValue('TCNB-CHI-HN-20260930-000001'),
    };
    const fundLedger = {
      lock: jest.fn(),
      code: jest.fn().mockReturnValue('QF-CHI-test'),
      invalidateClosings: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'LARK_EXPENSE_BASE_TOKEN') return 'finance-base';
        if (key === 'LARK_EXPENSE_TABLE_HN') return 'hn';
        return null;
      }),
    };
    return {
      service: new InternalFinanceLarkImportService(
        prisma as any,
        config as any,
        uploadService as any,
        lark as any,
        codeService as any,
        fundLedger as any,
      ),
      prisma,
      uploadService,
      lark,
      fundLedger,
      storedEntries,
    };
  };

  it('does not write during dry run and ignores the rollup table', async () => {
    const { service, prisma, uploadService } = makeService();

    const result = await service.importHistory({ sources: ['EXPENSE_HN'] }, 7);

    expect(result.dryRun).toBe(true);
    expect(result.tables[0]).toMatchObject({
      tableId: 'hn',
      fetched: 2,
      created: 1,
      skipped: 1,
      attachmentsDownloaded: 0,
      pendingAttachments: 1,
    });
    expect(result.attachments).toEqual({
      total: 1,
      downloaded: 0,
      failed: 0,
    });
    expect(result.tables.map((table) => table.tableId)).not.toContain('rollup');
    expect(prisma.internalFinanceEntry.create).not.toHaveBeenCalled();
    expect(prisma.cashFlow.create).not.toHaveBeenCalled();
    expect(prisma.internalFinanceWeeklyBatch.create).not.toHaveBeenCalled();
    expect(uploadService.saveFile).not.toHaveBeenCalled();
  });

  it('creates once, then updates the same source key without posting cash', async () => {
    const { service, prisma, uploadService } = makeService();
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.importHistory({ dryRun: false, sources: ['EXPENSE_HN'] }, 7);
    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKey: 'LARK:finance-base:hn:rec1',
          category: 'DELIVERY_FEE',
          branch: { connect: { id: 6 } },
          sourceSnapshot: expect.objectContaining({
            unmatchedInvoiceCodes: ['HD128738'],
          }),
        }),
      }),
    );
    expect(uploadService.saveFile).toHaveBeenCalled();
    const created = prisma.internalFinanceEntry.create.mock.calls[0][0].data;
    expect(created.cashFlowId).toBeUndefined();
    expect(created.weeklyBatchId).toBeUndefined();
    expect(created.cashFlow).toBeUndefined();
    expect(created.weeklyBatch).toBeUndefined();

    prisma.internalFinanceEntry.findMany.mockResolvedValue([
      {
        id: 9,
        sourceKey: 'LARK:finance-base:hn:rec1',
        status: 'PENDING_ACCOUNTANT',
        cashFlowId: null,
        sourceSnapshot: { importedFileTokens: ['file1'] },
      },
    ]);
    prisma.internalFinanceEntry.create.mockClear();

    const second = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );

    expect(second.tables[0].updated).toBe(1);
    expect(second.tables[0].created).toBe(0);
    expect(prisma.internalFinanceEntry.create).not.toHaveBeenCalled();
    expect(prisma.internalFinanceEntry.update).toHaveBeenCalled();
    expect(prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('does not overwrite an entry that already posted to CashFlow', async () => {
    const { service, prisma } = makeService();
    const postedRow = {
      id: 9,
      sourceKey: 'LARK:finance-base:hn:rec1',
      status: 'POSTED',
      cashFlowId: 4,
      cashIssued: false,
      code: 'TCNB-CHI-HN-1',
      sourceSnapshot: null,
    };
    prisma.internalFinanceEntry.findMany.mockImplementation(
      async (args: any = {}) =>
        args?.where?.sourceKey?.in ? [postedRow] : [],
    );

    const posted = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );
    expect(posted.tables[0]).toMatchObject({
      created: 0,
      updated: 0,
      skipped: 2,
    });
    expect(prisma.internalFinanceEntry.update).not.toHaveBeenCalled();
  });

  it('keeps the entry when a document download fails', async () => {
    const { service, prisma, lark } = makeService();
    lark.download.mockRejectedValue(new Error('Tải file Lark thất bại'));
    const failedFile = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );
    expect(failedFile.tables[0]).toMatchObject({
      created: 1,
    });
    expect(failedFile.attachments.failed).toBe(1);
    expect(failedFile.attachments.downloaded).toBe(0);
    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ evidenceStatus: 'MISSING' }),
      }),
    );
  });

  const vehicleLark = (twinFields: Record<string, unknown> = {}) => ({
    listTables: jest.fn(async (base: string) =>
      base === 'finance-base'
        ? tables
        : [{ tableId: 'fuel', name: 'KHO HN - Xăng dầu' }],
    ),
    listFieldNames: jest.fn(async (_base: string, tableId: string) =>
      tableId === 'fuel' ? ['Chọn xe', 'Số tiền'] : ['THÀNH TIỀN', 'NỘI DUNG'],
    ),
    forEachRecordPage: jest.fn(
      async (_base: string, tableId: string, _token: string, onPage: any) => {
        const page = { page: 1, pageRecords: 1, totalFetched: 1, hasMore: false };
        if (tableId === 'fuel') {
          await onPage(
            [
              {
                recordId: 'recFuel',
                fields: {
                  'Chọn xe': '29D - 223.09 - Xăng',
                  'Số tiền': '750000',
                  'Đơn giá': '27180',
                  'Số lít': 27.594,
                  ODO: '58674',
                  'Thời gian': 1791368871000,
                  'Lái xe': { id: 'ou_1', name: 'Đào Huy Sáng' },
                },
              },
            ],
            page,
          );
          return 1;
        }
        if (tableId !== 'hn') return 0;
        await onPage(
          [
            {
              recordId: 'recTwin',
              fields: {
                'NĂM/THÁNG/NGÀY': 1791368871000,
                'THÀNH TIỀN': { type: 2, value: [750000] },
                'NỘI DUNG': 'Xăng xe',
                'Khoản Mục': 'Xăng xe: oto, xe tại kho',
                'Người Chi': [{ id: 'ou_2', name: 'Dương Tuấn Anh' }],
                'Kế Toán Kho': true,
                'Quản Lý Kho': true,
                'Đã Chi': true,
                'Liên Kết Xăng Dầu': [
                  {
                    record_ids: ['recFuel'],
                    text: 'Xăng - 29D - 223.09 - Xăng - 2026/10/07',
                    type: 'text',
                  },
                ],
                ...twinFields,
              },
            },
          ],
          page,
        );
        return 1;
      },
    ),
  });
  const larkUsers = [
    { id: 5, name: 'Đào Huy Sáng', larkUserId: 'ou_1' },
    { id: 6, name: 'Dương Tuấn Anh', larkUserId: 'ou_2' },
  ];

  it('links a fuel row to its vehicle and treats the driver as the payer', async () => {
    const { service, prisma } = makeService({ lark: vehicleLark() });
    prisma.user.findMany.mockResolvedValue(larkUsers);

    const result = await service.importHistory(
      { dryRun: false, sources: ['FUEL'] },
      7,
    );

    expect(result.tables[0]).toMatchObject({ created: 1, skipped: 0 });
    expect(prisma.vehicle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          branchId: 6,
          label: '29D - 223.09 - Xăng',
          plate: '29D - 223.09',
          fuelType: 'GASOLINE',
          vehicleType: 'CAR',
        }),
      }),
    );
    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'FUEL',
          vehicle: { connect: { id: 31 } },
          payer: { connect: { id: 5 } },
          vehicleName: '29D - 223.09 - Xăng',
          expenseItem: 'Xăng xe: oto, xe tại kho',
        }),
      }),
    );
  });

  it('merges the expense-table twin of a fuel row instead of creating a second expense', async () => {
    const { service, prisma, storedEntries } = makeService({
      lark: vehicleLark(),
    });
    prisma.user.findMany.mockResolvedValue(larkUsers);

    const result = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN', 'FUEL'] },
      7,
    );

    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledTimes(1);
    const expenseTable = result.tables.find(
      (table: any) => table.source === 'EXPENSE_HN',
    );
    expect(expenseTable).toMatchObject({ created: 0, skipped: 1 });
    expect(storedEntries.size).toBe(1);
    expect([...storedEntries.values()][0]).toMatchObject({
      category: 'FUEL',
      payerId: 6,
      status: 'APPROVED',
      cashIssued: true,
    });
  });

  it('keeps a twin that differs in amount as its own expense', async () => {
    const { service, prisma } = makeService({
      lark: vehicleLark({ 'THÀNH TIỀN': { type: 2, value: [700000] } }),
    });
    prisma.user.findMany.mockResolvedValue(larkUsers);

    await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN', 'FUEL'] },
      7,
    );

    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledTimes(2);
  });

  it('maps an Approval week record into a branch batch with Lark serial dates', () => {
    const { service } = makeService();
    const row = (service as any).mapApprovalRow({
      source: 'APPROVAL_HN',
      baseToken: 'finance-base',
      table: { tableId: 'approval-hn', name: 'Approval PHIẾU CHI kho HN' },
      branchId: 6,
      kind: 'EXPENSE_HN',
      record: {
        recordId: 'rec-approval-1',
        fields: {
          'Tuần chi': 1,
          'Năm chi': ['2025'],
          'Ngày bắt đầu': '45660.70833',
          'Ngày kết thúc': '45660.70833',
          'Số tiền': '105000',
          'Trạng thái duyệt': ['Approved'],
          instance_code_1: 'INSTANCE-1',
          'Người tạo phiếu': [
            { id: 'ou_creator', name: 'Người tạo' },
          ],
        },
      },
    });

    expect(row).toMatchObject({
      branchId: 6,
      week: 1,
      year: 2025,
      totalAmount: 105000,
      status: 'APPROVED',
      instanceCode: 'INSTANCE-1',
      creatorRef: { id: 'ou_creator', name: 'Người tạo' },
    });
    expect(row.weekStart.getUTCFullYear()).toBe(2025);
    expect(row.weekStart.getUTCDate()).toBe(4);
  });

  it('creates one internal fund transaction for an already-issued entry without CashFlow', async () => {
    const { service, prisma, lark } = makeService();
    lark.forEachRecordPage.mockImplementation(
      async (_base: string, tableId: string, _token: string, onPage: any) => {
        if (tableId !== 'hn') return 0;
        await onPage(
          [
            {
              recordId: 'rec-issued',
              fields: {
                'Số tiền': 250000,
                'Nội dung': 'Chi tiền điện',
                'Đã chi': true,
              },
            },
          ],
          { page: 1, pageRecords: 1, totalFetched: 1, hasMore: false },
        );
        return 1;
      },
    );

    const result = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );

    expect(result.fundTransactions).toBe(1);
    expect(prisma.internalFundTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKey: 'EXPENSE:1',
          entryId: 1,
          transactionType: 'EXPENSE',
          status: 'POSTED',
        }),
      }),
    );
    expect(prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('does not create a fund transaction for a not-issued entry', async () => {
    const { service, prisma } = makeService();

    const result = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );

    expect(result.fundTransactions).toBe(0);
    expect(prisma.internalFundTransaction.create).not.toHaveBeenCalled();
    expect(prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('backfills the fund transaction and retries pending files for an issued entry', async () => {
    const { service, prisma } = makeService();
    const issuedRow = {
      id: 12,
      sourceKey: 'LARK:finance-base:hn:rec1',
      status: 'PENDING_ACCOUNTANT',
      cashFlowId: null,
      cashIssued: true,
      code: 'TCNB-CHI-HN-2',
      sourceSnapshot: {
        importedFileTokens: [],
        pendingAttachments: [
          { token: 'file1', name: 'bill.jpg', url: 'https://lark/file1' },
        ],
      },
    };
    prisma.internalFinanceEntry.findMany.mockImplementation(
      async (args: any = {}) => {
        const where = args?.where || {};
        if (where.sourceKey?.in) return [issuedRow];
        if (where.id?.in) return [issuedRow];
        return [];
      },
    );

    const result = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );

    expect(result.fundTransactions).toBe(1);
    expect(prisma.internalFundTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKey: 'EXPENSE:12',
          entryId: 12,
        }),
      }),
    );
    expect(result.attachments.downloaded).toBe(1);
    expect(prisma.internalFinanceAttachment.create).toHaveBeenCalled();
    expect(prisma.cashFlow.create).not.toHaveBeenCalled();
  });

  it('skips a delivery fee that POS already created from the packing slip', async () => {
    const { service, prisma, lark } = makeService();
    prisma.packingSlip.findMany.mockResolvedValue([
      { id: 25, code: 'BD00025' },
    ]);
    prisma.internalFinanceEntry.findMany.mockImplementation(async (args: any) => {
      const where = args?.where || {};
      if (where.sourceKey?.in) return [{ sourceKey: 'PACKING_SLIP:25:FEE_GRAB' }];
      return [];
    });
    lark.forEachRecordPage.mockImplementation(
      async (_base: string, tableId: string, _token: string, onPage: any) => {
        if (tableId !== 'hn') return 0;
        await onPage(
          [
            {
              recordId: 'rec-slip',
              fields: {
                'Số tiền': 100000,
                'Nội dung': 'Phí Grab HD128738',
                'Mã Báo Đơn': 'BD00025',
              },
            },
          ],
          { page: 1, pageRecords: 1, totalFetched: 1, hasMore: false },
        );
        return 1;
      },
    );

    const result = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );

    expect(result.tables[0]).toMatchObject({ created: 0, skipped: 1 });
    expect(prisma.internalFinanceEntry.create).not.toHaveBeenCalled();
  });
});
