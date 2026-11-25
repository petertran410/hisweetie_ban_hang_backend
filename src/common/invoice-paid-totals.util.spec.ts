import {
  nextInvoicePaidTotals,
  recalcInvoicePaidTotals,
} from './invoice-paid-totals.util';
import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';

describe('nextInvoicePaidTotals', () => {
  it('hết đủ tiền: Hoàn thành → Giao thành công, còn nợ = tổng − đã trả', () => {
    expect(
      nextInvoicePaidTotals(
        { grandTotal: 1315000, status: INVOICE_STATUS.COMPLETED },
        0,
        0,
      ),
    ).toEqual({
      paidAmount: 0,
      debtAmount: 1315000,
      status: INVOICE_STATUS.DELIVERED,
      statusValue: 'Giao thành công',
    });
  });

  it('đủ tiền (kể cả CTN): Giao thành công → Hoàn thành, trả dư thì còn nợ 0', () => {
    expect(
      nextInvoicePaidTotals(
        { grandTotal: 1000, status: INVOICE_STATUS.DELIVERED },
        900,
        200,
      ),
    ).toEqual({
      paidAmount: 1100,
      debtAmount: 0,
      status: INVOICE_STATUS.COMPLETED,
      statusValue: 'Hoàn thành',
    });
  });

  it('hóa đơn đã hủy giữ nguyên trạng thái', () => {
    expect(
      nextInvoicePaidTotals(
        { grandTotal: 1000, status: INVOICE_STATUS.CANCELLED },
        0,
        0,
      ),
    ).toEqual({ paidAmount: 0, debtAmount: 1000 });
  });
});

describe('recalcInvoicePaidTotals', () => {
  it('cộng phiếu còn hiệu lực + CTN rồi lưu', async () => {
    const tx = {
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          grandTotal: 2065000,
          status: INVOICE_STATUS.PROCESSING,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      invoicePayment: {
        findMany: jest.fn().mockResolvedValue([{ amount: 261000 }]),
      },
      returnOrder: {
        findMany: jest.fn().mockResolvedValue([{ refundAmount: 4000 }]),
      },
    };

    await recalcInvoicePaidTotals(tx, 7);

    expect(tx.invoicePayment.findMany).toHaveBeenCalledWith({
      where: { invoiceId: 7, status: { not: 2 } },
      select: { amount: true },
    });
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        paidAmount: 265000,
        debtAmount: 1800000,
        status: INVOICE_STATUS.PROCESSING,
        statusValue: 'Đang xử lý',
      },
    });
  });
});
