import { INVOICE_STATUS } from '../../invoices/dto/invoice-status.constants';
import { SyncInvoiceService } from './sync-invoice.service';
import { SyncOrderService } from './sync-order.service';

const emptyContext = {
  customerByCode: new Map(),
  branchByKiotId: new Map(),
  userByKiotId: new Map(),
  saleChannelByKiotId: new Map(),
  productByKiotId: new Map(),
  productByCode: new Map(),
  surchargeByKiotId: new Map(),
  bankAccountByKiotId: new Map(),
};

describe('Kiot sales sync with preserved shipping fee', () => {
  it('đồng bộ order paymentStatus thành partial khi shipping còn tạo công nợ', async () => {
    const existing = {
      id: 1,
      customerId: null,
      branchId: null,
      soldById: null,
      saleChannelId: null,
      shippingFee: 20,
    };
    const prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue(existing),
      },
    };
    const service = new SyncOrderService(prisma as any, {} as any);

    await (service as any).upsertWithCtx(
      { code: 'DH1', total: 100, totalPayment: 100, status: 3 },
      emptyContext,
    );

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          grandTotal: 120,
          paidAmount: 100,
          debtAmount: 20,
          paymentStatus: 'partial',
        }),
      }),
    );
  });

  it('lùi invoice hoàn thành về đã giao khi shipping còn tạo công nợ', async () => {
    const existing = {
      id: 2,
      customerId: null,
      branchId: null,
      orderId: null,
      soldById: null,
      saleChannelId: null,
      shippingFee: 20,
      purchaseDate: new Date(),
    };
    const prisma = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue(existing),
      },
      invoiceDetail: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = new SyncInvoiceService(prisma as any, {} as any);

    await (service as any).upsertWithCtx(
      {
        code: 'HD1',
        total: 100,
        totalPayment: 100,
        status: INVOICE_STATUS.COMPLETED,
        statusValue: 'Hoàn thành',
      },
      { ...emptyContext, orderByCode: new Map() },
    );

    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          grandTotal: 120,
          debtAmount: 20,
          status: INVOICE_STATUS.DELIVERED,
          statusValue: 'Giao thành công',
        }),
      }),
    );
  });
});
