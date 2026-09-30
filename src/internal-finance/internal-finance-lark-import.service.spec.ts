import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';

describe('InternalFinanceLarkImportService', () => {
  const tables = [
    { tableId: 'hn', name: 'Tổng hợp phiếu chi kho HN' },
    { tableId: 'rollup', name: 'Giao Dịch Tiền Mặt - Kho' },
    { tableId: 'receipt', name: 'Phiếu thu' },
  ];

  const makeService = (overrides: any = {}) => {
    const prisma = {
      internalFinanceEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({ id: 1 }),
      },
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      packingSlip: { findMany: jest.fn().mockResolvedValue([]) },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlow: { create: jest.fn() },
      internalFinanceWeeklyBatch: { create: jest.fn() },
      ...overrides.prisma,
    };
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
      ),
      prisma,
      uploadService,
      lark,
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

  it('does not overwrite a posted row and still saves the entry when a file fails', async () => {
    const { service, prisma, lark } = makeService();
    prisma.internalFinanceEntry.findMany.mockResolvedValueOnce([
      {
        id: 9,
        sourceKey: 'LARK:finance-base:hn:rec1',
        status: 'POSTED',
        cashFlowId: 4,
        sourceSnapshot: null,
      },
    ]);

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

    prisma.internalFinanceEntry.findMany.mockResolvedValue([]);
    lark.download.mockRejectedValue(new Error('Tải file Lark thất bại'));
    const failedFile = await service.importHistory(
      { dryRun: false, sources: ['EXPENSE_HN'] },
      7,
    );
    expect(failedFile.tables[0]).toMatchObject({
      created: 1,
      attachmentsFailed: 1,
    });
    expect(prisma.internalFinanceEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ evidenceStatus: 'MISSING' }),
      }),
    );
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
});
