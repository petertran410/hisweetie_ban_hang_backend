import { CashFlowHistoryAuditService } from './cashflow-history-audit.service';

describe('CashFlowHistoryAuditService', () => {
  it('normalizes Lark cash transactions and finds POS candidates', async () => {
    const prisma = {
      cashFlow: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 88,
            code: 'PCT-88',
            amount: 500000,
            transDate: new Date('2026-09-20T08:00:00+07:00'),
            description: 'Chi kho',
          },
        ]),
      },
    };
    const larkClient = {
      bitable: {
        appTableRecord: {
          search: jest.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec-lark-1',
                  fields: {
                    'Mã Phiếu': '260920.1.10TMHN',
                    'Chi Nhánh': ['Kho Hà Nội'],
                    'Ngày Giao Dịch': '2026-09-20T00:00:00+07:00',
                    Chi: 500000,
                    Thu: null,
                    'Dòng Tiền': -500000,
                    'Nội Dung': 'Chi kho',
                    'Loại Thu Chi': ['Phiếu Chi Kho HN'],
                    'Trạng Thái': null,
                  },
                },
              ],
              has_more: false,
            },
          }),
        },
      },
    };
    const service = new CashFlowHistoryAuditService(
      prisma as any,
      { get: jest.fn().mockReturnValue('base-token') } as any,
      larkClient as any,
    );

    const result = await service.preview();

    expect(result.hasMore).toBe(false);
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        sourceRecordId: 'rec-lark-1',
        branchId: 6,
        isReceipt: false,
        amount: 500000,
        canceled: false,
      }),
    );
    expect(result.data[0].candidates).toHaveLength(1);
    expect(prisma.cashFlow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 6,
          isReceipt: false,
          amount: 500000,
        }),
      }),
    );
  });

  it('keeps unknown branches visible and does not query candidates', async () => {
    const prisma = {
      cashFlow: { findMany: jest.fn() },
    };
    const larkClient = {
      bitable: {
        appTableRecord: {
          search: jest.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec-lark-unknown',
                  fields: {
                    'Chi Nhánh': ['Cửa Hàng Diệp Trà'],
                    Chi: 100,
                    'Trạng Thái': ['Hủy'],
                  },
                },
              ],
              has_more: false,
            },
          }),
        },
      },
    };
    const service = new CashFlowHistoryAuditService(
      prisma as any,
      { get: jest.fn().mockReturnValue('base-token') } as any,
      larkClient as any,
    );

    const result = await service.preview();

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        branchId: null,
        canceled: true,
        amount: 100,
      }),
    );
    expect(prisma.cashFlow.findMany).not.toHaveBeenCalled();
  });
});
