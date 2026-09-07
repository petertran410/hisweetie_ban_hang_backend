import { OrdersService } from './orders.service';
import { INVOICE_STATUS } from '../invoices/dto';

describe('OrdersService findOne', () => {
  it('chỉ loại invoice đã hủy khỏi relation', async () => {
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    };
    const service = new OrdersService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.findOne(1);

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          invoices: expect.objectContaining({
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
          }),
        }),
      }),
    );
  });
});
