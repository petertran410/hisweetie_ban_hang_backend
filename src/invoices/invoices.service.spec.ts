import { InvoicesService } from './invoices.service';
import { INVOICE_STATUS } from './dto';

describe('InvoicesService delivery reporting', () => {
  const createInvoice = (deliveredAt: Date | null) => ({
    id: 1,
    code: 'HDTEST001',
    status: INVOICE_STATUS.PROCESSING,
    statusValue: 'Đang xử lý',
    deliveredAt,
    createdBy: 7,
    customerId: null,
    branchId: 1,
    orderId: null,
    details: [],
    customer: null,
    payments: [],
    delivery: null,
    branch: null,
    soldBy: null,
    purchaseDate: new Date('2026-08-27T09:00:00.000Z'),
    grandTotal: 100_000,
    totalAmount: 100_000,
    discount: 0,
    discountRatio: 0,
    paidAmount: 0,
    debtAmount: 100_000,
    description: null,
    usingCod: false,
    priceBookName: null,
  });

  const createService = (
    currentInvoice: ReturnType<typeof createInvoice>,
    firstPackingSlipAt: Date | null = null,
  ) => {
    const tx = {
      invoice: {
        findUnique: jest.fn().mockResolvedValue(currentInvoice),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...currentInvoice,
            ...data,
            creator: { id: currentInvoice.createdBy, name: 'Người tạo' },
            priceBook: null,
          }),
        ),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Người báo đơn' }),
      },
      packingSlipInvoice: {
        findFirst: jest.fn().mockResolvedValue(
          firstPackingSlipAt
            ? { packingSlip: { createdAt: firstPackingSlipAt } }
            : null,
        ),
      },
    };
    const prisma = {
      invoice: { findUnique: jest.fn().mockResolvedValue(currentInvoice) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const auditLogs = { create: jest.fn().mockResolvedValue(undefined) };
    const service = new InvoicesService(
      prisma as any,
      {} as any,
      {} as any,
      auditLogs as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(currentInvoice as any);

    return { service, tx };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ghi mốc báo đơn khi chuyển trực tiếp sang Giao thành công', async () => {
    const reportedAt = new Date('2026-08-27T09:30:00.000Z');
    jest.useFakeTimers().setSystemTime(reportedAt);
    const { service, tx } = createService(createInvoice(null));

    await service.update(
      1,
      { status: INVOICE_STATUS.DELIVERED } as any,
      9,
    );

    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          status: INVOICE_STATUS.DELIVERED,
          deliveredAt: reportedAt,
        }),
      }),
    );
  });

  it('giữ nguyên mốc giao sớm nhất khi hóa đơn đã có deliveredAt', async () => {
    const firstDeliveredAt = new Date('2026-08-26T09:30:00.000Z');
    const { service, tx } = createService(createInvoice(firstDeliveredAt));

    await service.update(
      1,
      { status: INVOICE_STATUS.DELIVERED } as any,
      9,
    );

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toBeUndefined();
  });

  it('ưu tiên mốc phiếu giao sớm nhất khi dữ liệu cũ chưa có deliveredAt', async () => {
    const firstPackingSlipAt = new Date('2026-08-26T08:00:00.000Z');
    const { service, tx } = createService(
      createInvoice(null),
      firstPackingSlipAt,
    );

    await service.update(
      1,
      { status: INVOICE_STATUS.DELIVERED } as any,
      9,
    );

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toEqual(firstPackingSlipAt);
  });

  it('không xem thao tác Hoàn thành là một lần báo đơn', async () => {
    const { service, tx } = createService(createInvoice(null));

    await service.update(1, { status: INVOICE_STATUS.COMPLETED } as any, 9);

    const updateInput = tx.invoice.update.mock.calls[0][0];
    expect(updateInput.data.deliveredAt).toBeUndefined();
    expect(tx.packingSlipInvoice.findFirst).not.toHaveBeenCalled();
  });
});
