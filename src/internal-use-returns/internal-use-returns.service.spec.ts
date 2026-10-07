import { BadRequestException } from '@nestjs/common';
import { InternalUseReturnsService } from './internal-use-returns.service';
import { computeOnHandFromLogs } from '../common/inventory-onhand.util';

describe('InternalUseReturnsService', () => {
  const createService = () =>
    new InternalUseReturnsService({} as any, {} as any, {} as any);

  it('builds return details from completed internal-use lines and subtracts existing requests', async () => {
    const service = createService();
    const tx = {
      internalUseReturn: {
        findMany: jest.fn().mockResolvedValue([
          {
            details: [
              {
                internalUseDetailId: 11,
                requestQuantity: 2,
              },
            ],
          },
        ]),
      },
    };
    const source = {
      id: 7,
      code: 'XDNB000007',
      details: [
        {
          id: 11,
          productId: 101,
          productCode: 'SP101',
          productName: 'Sản phẩm 101',
          unit: 'cái',
          quantity: 5,
          conditionType: 'normal',
          soldExpiryDate: null,
        },
      ],
    };

    const details = await (service as any).buildDetails(tx, source, [
      { internalUseDetailId: 11, requestQuantity: 3 },
    ]);

    expect(details[0]).toMatchObject({
      internalUseDetailId: 11,
      productId: 101,
      issuedQuantity: 5,
      requestQuantity: 3,
      sourceConditionType: 'normal',
    });
  });

  it('rejects a return that exceeds the remaining quantity', async () => {
    const service = createService();
    const tx = {
      internalUseReturn: {
        findMany: jest.fn().mockResolvedValue([
          {
            details: [
              {
                internalUseDetailId: 11,
                requestQuantity: 4,
              },
            ],
          },
        ]),
      },
    };
    const source = {
      id: 7,
      code: 'XDNB000007',
      details: [
        {
          id: 11,
          productId: 101,
          productCode: 'SP101',
          productName: 'Sản phẩm 101',
          quantity: 5,
          conditionType: 'normal',
          soldExpiryDate: null,
        },
      ],
    };

    await expect(
      (service as any).buildDetails(tx, source, [
        { internalUseDetailId: 11, requestQuantity: 2 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    {
      condition: 'normal',
      expected: { goodQuantity: 4, damagedQuantity: 0, nearExpiryQuantity: 0 },
    },
    {
      condition: 'damaged',
      expected: { goodQuantity: 0, damagedQuantity: 4, nearExpiryQuantity: 0 },
    },
    {
      condition: 'near_expiry',
      expected: { goodQuantity: 0, damagedQuantity: 0, nearExpiryQuantity: 4 },
    },
  ])('defaults received buckets from source condition: $condition', (testCase) => {
    const service = createService();
    const result = (service as any).resolveBuckets(
      {
        productName: 'Sản phẩm',
        requestQuantity: 4,
        sourceConditionType: testCase.condition,
      },
      {},
    );

    expect(result).toMatchObject({
      ...testCase.expected,
      confirmedQuantity: 4,
    });
  });

  it('rejects received buckets above the requested quantity', () => {
    const service = createService();

    expect(() =>
      (service as any).resolveBuckets(
        {
          productName: 'Sản phẩm',
          requestQuantity: 4,
          sourceConditionType: 'normal',
        },
        { goodQuantity: 3, damagedQuantity: 2 },
      ),
    ).toThrow(BadRequestException);
  });

  it('normalizes near-expiry lots to the first day of the month', () => {
    const service = createService();
    const result = (service as any).resolveBuckets(
      {
        productName: 'Sản phẩm',
        requestQuantity: 2,
        sourceConditionType: 'near_expiry',
      },
      { nearExpiryQuantity: 2, nearExpiryDate: '2026-10-25' },
    );

    expect(result.nearExpiryDate.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('excludes inventory logs owned by a cancelled internal-use return', async () => {
    const tx = {
      inventoryLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            quantity: 10,
            refType: 'manual',
            refId: 1,
          },
          {
            quantity: 4,
            refType: 'internal_use_return',
            refId: 8,
          },
        ]),
      },
      internalUseReturn: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await expect(computeOnHandFromLogs(tx, 101, 1)).resolves.toBe(10);
  });
});
