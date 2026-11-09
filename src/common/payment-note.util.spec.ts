import {
  latestPaymentNote,
  packingCashWarning,
  withInvoicePaymentNote,
} from './payment-note.util';

describe('payment-note.util', () => {
  it('latestPaymentNote lấy ghi chú đầu tiên và đổi số tiền sang number', () => {
    expect(
      latestPaymentNote([{ paymentType: 'cash', amount: '850000' }]),
    ).toEqual({
      paymentType: 'cash',
      amount: 850000,
    });
    expect(
      latestPaymentNote([{ paymentType: 'transfer', amount: null }]),
    ).toEqual({
      paymentType: 'transfer',
      amount: null,
    });
    expect(latestPaymentNote([])).toBeNull();
    expect(latestPaymentNote(undefined)).toBeNull();
  });

  it('withInvoicePaymentNote thay paymentNotes bằng paymentNote, giữ dòng ký gửi', () => {
    const rows = withInvoicePaymentNote([
      {
        id: 1,
        invoice: {
          id: 10,
          code: 'HD1',
          paymentNotes: [{ paymentType: 'cash', amount: 300000 }],
        },
        consignment: null,
      },
      {
        id: 2,
        invoice: { id: 11, code: 'HD2', paymentNotes: [] },
        consignment: null,
      },
      { id: 3, invoice: null, consignment: { id: 5, code: 'KG1' } },
    ]);
    expect(rows[0]).toEqual({
      id: 1,
      invoice: {
        id: 10,
        code: 'HD1',
        paymentNote: { paymentType: 'cash', amount: 300000 },
      },
      consignment: null,
    });
    expect(rows[1].invoice).toEqual({ id: 11, code: 'HD2', paymentNote: null });
    expect(rows[2]).toEqual({
      id: 3,
      invoice: null,
      consignment: { id: 5, code: 'KG1' },
    });
    expect(withInvoicePaymentNote(null)).toEqual([]);
  });

  describe('packingCashWarning', () => {
    const inv = (
      code: string,
      paymentType?: string,
      amount?: number | null,
    ) => ({
      invoice: {
        code,
        paymentNote: paymentType
          ? { paymentType, amount: amount ?? null }
          : null,
      },
    });

    it('khớp tiền mặt thì không cảnh báo', () => {
      expect(
        packingCashWarning({ paymentMethod: 'cash', cashAmount: '850000' }, [
          inv('HD1', 'cash', 850000),
        ]),
      ).toBeNull();
    });

    it('nhiều hóa đơn tiền mặt: cộng dồn rồi so với phiếu', () => {
      const items = [inv('HD1', 'cash', 500000), inv('HD2', 'cash', 800000)];
      expect(
        packingCashWarning(
          { paymentMethod: 'cash', cashAmount: 1300000 },
          items,
        ),
      ).toBeNull();
      expect(
        packingCashWarning(
          { paymentMethod: 'cash', cashAmount: 1000000 },
          items,
        ),
      ).toEqual({
        kind: 'amount',
        invoiceCash: 1300000,
        slipCash: 1000000,
        codes: ['HD1', 'HD2'],
      });
    });

    it('hóa đơn tiền mặt mà phiếu chuyển khoản thì cảnh báo', () => {
      expect(
        packingCashWarning({ paymentMethod: 'transfer', cashAmount: 0 }, [
          inv('HD1', 'cash', 500000),
          inv('HD2', 'transfer'),
        ]),
      ).toEqual({
        kind: 'transfer',
        invoiceCash: 500000,
        slipCash: 0,
        codes: ['HD1'],
      });
    });

    it('phiếu thu tiền mặt mà hóa đơn ghi chuyển khoản thì cảnh báo lệch', () => {
      expect(
        packingCashWarning({ paymentMethod: 'cash', cashAmount: 500000 }, [
          inv('HD1', 'transfer'),
        ]),
      ).toMatchObject({ kind: 'amount', invoiceCash: 0, slipCash: 500000 });
    });

    it('không cảnh báo khi chưa có ghi chú, phiếu đã hủy, hoặc lệch dưới 1 đồng', () => {
      expect(
        packingCashWarning({ paymentMethod: 'cash', cashAmount: 500000 }, [
          inv('HD1'),
          { invoice: null },
        ]),
      ).toBeNull();
      expect(
        packingCashWarning(
          { paymentMethod: 'transfer', cancelledAt: new Date() },
          [inv('HD1', 'cash', 500000)],
        ),
      ).toBeNull();
      expect(
        packingCashWarning({ paymentMethod: 'cash', cashAmount: 850000.4 }, [
          inv('HD1', 'cash', 850000),
        ]),
      ).toBeNull();
      expect(packingCashWarning({ paymentMethod: 'cash' }, null)).toBeNull();
    });
  });
});
