import { OrdersService } from '../orders/orders.service';
import { ConsignmentsService } from '../consignments/consignments.service';

describe('document shipping fee totals', () => {
  it('includes shipping fee when recalculating an order', async () => {
    const service = new OrdersService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    const tx = {
      orderItem: {
        findMany: jest.fn().mockResolvedValue([{ totalPrice: 100_000 }]),
      },
      orderPayment: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          discount: 10_000,
          discountRatio: 0,
          shippingFee: 15_000,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    await service.calculateTotals(1, tx);

    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalAmount: 100_000,
          grandTotal: 105_000,
          debtAmount: 105_000,
        }),
      }),
    );
  });

  it('includes shipping fee when recalculating a consignment', async () => {
    const service = new ConsignmentsService(
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    const tx = {
      consignmentItem: {
        findMany: jest.fn().mockResolvedValue([{ totalPrice: 100_000 }]),
      },
      consignment: {
        findUnique: jest.fn().mockResolvedValue({
          discount: 10_000,
          discountRatio: 0,
          shippingFee: 15_000,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    await service.calculateTotals(1, tx);

    expect(tx.consignment.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        totalAmount: 100_000,
        grandTotal: 105_000,
        discount: 10_000,
      },
    });
  });
});
