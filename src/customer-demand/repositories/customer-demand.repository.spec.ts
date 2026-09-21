import { BadRequestException } from '@nestjs/common';
import { CustomerDemandRepository } from './customer-demand.repository';

describe('CustomerDemandRepository.updateMonth', () => {
  const sourceCreatedAt = new Date('2025-08-22T09:01:57.000Z');
  const sourceUpdatedAt = new Date('2025-12-23T07:35:59.000Z');

  function setup() {
    const tx = {
      customerDemand: {
        update: jest.fn(),
      },
      customerDemandMonth: {
        findUnique: jest.fn().mockResolvedValue({
          id: 10,
          demandId: 20,
          demandMonth: new Date('2026-09-01T00:00:00.000Z'),
          demand: { id: 20, sourceSystem: 'LARK' },
          lines: [
            {
              id: 100,
              productId: 1,
              inputQuantity: 10,
              inputUnit: 'BASE',
              quantityBase: 10,
              conversionValue: 1,
              sourceCreatedAt,
              sourceUpdatedAt,
            },
          ],
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 10 }),
      },
      customerDemandLine: {
        create: jest.fn().mockResolvedValue({ id: 101 }),
        update: jest.fn().mockResolvedValue({ id: 100 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        aggregate: jest.fn().mockResolvedValue({
          _max: { sourceCreatedAt, sourceUpdatedAt },
        }),
      },
      customerDemandChangeLog: { create: jest.fn() },
    };
    const repository = new CustomerDemandRepository({
      $transaction: (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
    } as any);
    return { repository, tx };
  }

  it('giữ ID và ngày nguồn khi sửa dòng Lark, chỉ tạo dòng mới khi không có ID', async () => {
    const { repository, tx } = setup();

    await repository.updateMonth(10, {
      customerId: 2,
      demandMonth: new Date('2026-09-01T00:00:00.000Z'),
      updatedBy: 7,
      lines: [
        {
          id: 100,
          productId: 1,
          inputQuantity: 12,
          inputUnit: 'BASE',
          quantityBase: 12,
          conversionValue: 1,
        },
        {
          productId: 1,
          inputQuantity: 2,
          inputUnit: 'CARTON',
          quantityBase: 24,
          conversionValue: 12,
        },
      ],
    });

    expect(tx.customerDemandLine.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        productId: 1,
        inputQuantity: 12,
        inputUnit: 'BASE',
        quantityBase: 12,
        conversionValue: 1,
      },
    });
    expect(tx.customerDemand.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { updatedBy: 7, customerId: 2 },
    });
    expect(tx.customerDemandLine.deleteMany).toHaveBeenCalledWith({
      where: { demandMonthId: 10, id: { notIn: [100, 101] } },
    });
    expect(tx.customerDemand.update).toHaveBeenLastCalledWith({
      where: { id: 20 },
      data: { createdAt: sourceCreatedAt, updatedAt: sourceUpdatedAt },
    });
  });

  it('từ chối ID dòng thuộc tháng khác trước khi thay đổi dòng', async () => {
    const { repository, tx } = setup();

    await expect(
      repository.updateMonth(10, {
        demandMonth: new Date('2026-09-01T00:00:00.000Z'),
        updatedBy: 7,
        lines: [{
          id: 999,
          productId: 1,
          inputQuantity: 12,
          inputUnit: 'BASE',
          quantityBase: 12,
          conversionValue: 1,
        }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.customerDemandLine.deleteMany).not.toHaveBeenCalled();
  });
});
