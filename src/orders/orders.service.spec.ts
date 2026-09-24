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

describe('OrdersService findAll', () => {
  it('trả loại công nợ hiện tại cùng khách hàng trong danh sách', async () => {
    const order = {
      id: 1,
      customer: { id: 2, debtPolicy: { debtRuleType: 'CREDIT_LIMIT' } },
    };
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([order]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new OrdersService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.findAll({ page: 1, limit: 15 } as any);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          customer: expect.objectContaining({
            select: expect.objectContaining({
              debtPolicy: { select: { debtRuleType: true } },
            }),
          }),
        }),
      }),
    );
    expect(result.data[0].customer?.debtPolicy?.debtRuleType).toBe(
      'CREDIT_LIMIT',
    );
  });
});
