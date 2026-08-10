import { BadRequestException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import {
  BUCKET_DAMAGED,
  BUCKET_NEAR_EXPIRY,
  BUCKET_PROMO,
} from '../common/stock-condition-onhand.util';

describe('InvoicesService condition stock', () => {
  const createService = (logs: any[] = []) => {
    const create = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      stockConditionLog: {
        create,
        findMany: jest.fn().mockResolvedValue(logs),
      },
    };
    const service = new InvoicesService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, create };
  };

  const params = {
    branchId: 6,
    branchName: 'Kho test',
    invoiceCode: 'HD-TEST',
    invoiceId: 100,
    transactionDate: new Date('2026-07-30T00:00:00.000Z'),
  };

  it.each([
    {
      name: 'bán hàng bục rách',
      item: {
        productId: 1,
        productCode: 'SP1',
        productName: 'SP 1',
        quantity: 3,
        conditionType: 'damaged',
      },
      expected: { bucket: BUCKET_DAMAGED, quantity: -3, expiryDate: null },
    },
    {
      name: 'bán hàng cận date đúng lô',
      item: {
        productId: 1,
        productCode: 'SP1',
        productName: 'SP 1',
        quantity: 4,
        conditionType: 'near_expiry',
        soldExpiryDate: '2026-08-01',
      },
      expected: {
        bucket: BUCKET_NEAR_EXPIRY,
        quantity: -4,
        expiryDate: new Date('2026-08-01'),
      },
    },
    {
      name: 'xuất quà khuyến mãi',
      item: {
        productId: 1,
        productCode: 'SP1',
        productName: 'SP 1',
        quantity: 2,
        conditionType: 'normal',
        isGift: true,
      },
      expected: { bucket: BUCKET_PROMO, quantity: -2, expiryDate: null },
    },
  ])('ghi SALE_OUT khi $name', async ({ item, expected }) => {
    const { service, create } = createService();

    await (service as any).writeSaleConditionLog(
      { stockConditionLog: { create } },
      {
        ...params,
        item,
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transactionType: 'SALE_OUT',
        refType: 'invoice',
        refId: params.invoiceId,
        bucket: expected.bucket,
        quantity: expected.quantity,
        expiryDate: expected.expiryDate,
      }),
    });
  });

  it('không ghi StockConditionLog khi bán hàng thường', async () => {
    const { service, create } = createService();

    await (service as any).writeSaleConditionLog(
      { stockConditionLog: { create } },
      {
        ...params,
        item: {
          productId: 1,
          productCode: 'SP1',
          productName: 'SP 1',
          quantity: 1,
          conditionType: 'normal',
        },
      },
    );

    expect(create).not.toHaveBeenCalled();
  });

  it('chặn bán cận date vượt tồn đúng lô dù tổng bucket còn đủ', async () => {
    const logs = [
      {
        quantity: 2,
        bucket: BUCKET_NEAR_EXPIRY,
        expiryDate: new Date('2026-08-01T00:00:00.000Z'),
        refType: 'manual',
        refId: 1,
      },
      {
        quantity: 10,
        bucket: BUCKET_NEAR_EXPIRY,
        expiryDate: new Date('2026-09-01T00:00:00.000Z'),
        refType: 'manual',
        refId: 2,
      },
    ];
    const { service, prisma } = createService(logs);

    await expect(
      (service as any).validateConditionQuantity(
        prisma,
        1,
        6,
        3,
        'near_expiry',
        '2026-08-01',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cho bán khi đúng lô còn đủ tồn', async () => {
    const logs = [
      {
        quantity: 5,
        bucket: BUCKET_NEAR_EXPIRY,
        expiryDate: new Date('2026-08-01T00:00:00.000Z'),
        refType: 'manual',
        refId: 1,
      },
    ];
    const { service, prisma } = createService(logs);

    await expect(
      (service as any).validateConditionQuantity(
        prisma,
        1,
        6,
        5,
        'near_expiry',
        '2026-08-01',
      ),
    ).resolves.toBeUndefined();
  });
});
