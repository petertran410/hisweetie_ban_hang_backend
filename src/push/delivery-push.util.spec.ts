import { buildDeliveryPushes, type DeliveredSlip } from './delivery-push.util';

const inv = (
  id: number,
  soldById: number | null,
  customer: string | null = 'Chị Lan',
) => ({
  invoice: {
    id,
    code: `HD${id}`,
    soldById,
    customer: customer === null ? null : { name: customer },
  },
});

describe('buildDeliveryPushes', () => {
  const slip: DeliveredSlip = {
    code: 'BD000321',
    invoices: [inv(1, 10), inv(2, 20, null), inv(3, null), { invoice: null }],
  };

  it('mỗi hóa đơn có người bán một thông báo, kèm mã HĐ và tên khách', () => {
    expect(buildDeliveryPushes(slip, 99)).toEqual([
      {
        userId: 10,
        title: 'Đã giao hàng thành công',
        body: 'HD1 · Chị Lan — báo đơn BD000321',
        data: { type: 'invoice-delivered', invoiceId: 1 },
      },
      {
        userId: 20,
        title: 'Đã giao hàng thành công',
        body: 'HD2 — báo đơn BD000321',
        data: { type: 'invoice-delivered', invoiceId: 2 },
      },
    ]);
  });

  it('không báo cho người bán chính là người vừa báo đơn', () => {
    expect(buildDeliveryPushes(slip, 10).map((m) => m.userId)).toEqual([20]);
  });

  it('khi sửa báo đơn chỉ báo cho hóa đơn mới thêm', () => {
    expect(
      buildDeliveryPushes(slip, 99, [2]).map((m) => m.data?.invoiceId),
    ).toEqual([2]);
    expect(buildDeliveryPushes(slip, 99, [])).toEqual([]);
  });

  it('hóa đơn lặp trong báo đơn chỉ báo một lần', () => {
    const dup: DeliveredSlip = {
      code: 'BD1',
      invoices: [inv(1, 10), inv(1, 10)],
    };
    expect(buildDeliveryPushes(dup, undefined)).toHaveLength(1);
  });
});
