import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { computeBucketTotals } from '../common/stock-condition-onhand.util';
import { CreateInternalUseDto } from './dto';
import { InternalUseService } from './internal-use.service';

describe('InternalUseService condition stock', () => {
  const createService = () =>
    new InternalUseService({} as any, {} as any, {} as any);

  it('DTO accepts the supported conditions and rejects invalid values/dates', async () => {
    const valid = plainToInstance(CreateInternalUseDto, {
      branchId: 1,
      purposeId: 1,
      internalUseDetails: [
        {
          productId: 1,
          productCode: 'SP1',
          productName: 'Sản phẩm 1',
          quantity: 1,
          conditionType: 'near_expiry',
          soldExpiryDate: '2026-08-01',
        },
      ],
    });
    expect(await validate(valid)).toHaveLength(0);

    const invalid = plainToInstance(CreateInternalUseDto, {
      branchId: 1,
      purposeId: 1,
      internalUseDetails: [
        {
          productId: 1,
          productCode: 'SP1',
          productName: 'Sản phẩm 1',
          quantity: 1,
          conditionType: 'expired',
          soldExpiryDate: 'not-a-date',
        },
      ],
    });
    const errors = await validate(invalid);
    expect(errors[0]?.children?.[0]?.children?.length).toBeGreaterThan(0);
  });

  it('normalizes legacy details to normal stock and dates to the first of month', () => {
    const service = createService();
    const [legacy, nearExpiry] = (service as any).normalizeDetails([
      {},
      {
        conditionType: 'near_expiry',
        soldExpiryDate: '2026-08-25T12:00:00.000Z',
      },
    ]);

    expect(legacy).toMatchObject({
      conditionType: 'normal',
      soldExpiryDate: null,
    });
    expect(nearExpiry.conditionType).toBe('near_expiry');
    expect(nearExpiry.soldExpiryDate.toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('validates duplicate damaged rows cumulatively', async () => {
    const service = createService();
    const tx = {
      stockConditionLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            quantity: 5,
            bucket: 'DAMAGED',
            refType: 'manual',
            refId: 1,
          },
        ]),
      },
    };

    await expect(
      (service as any).validateConditionAvailability(
        tx,
        [
          {
            productId: 1,
            productName: 'Sản phẩm 1',
            quantity: 3,
            conditionType: 'damaged',
          },
          {
            productId: 1,
            productName: 'Sản phẩm 1',
            quantity: 3,
            conditionType: 'damaged',
          },
        ],
        2,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates dated and unknown near-expiry lots independently', async () => {
    const service = createService();
    const tx = {
      stockConditionLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            quantity: 2,
            bucket: 'NEAR_EXPIRY',
            expiryDate: new Date('2026-08-01T00:00:00.000Z'),
            refType: 'manual',
            refId: 1,
          },
          {
            quantity: 4,
            bucket: 'NEAR_EXPIRY',
            expiryDate: null,
            refType: 'manual',
            refId: 2,
          },
        ]),
      },
    };

    await expect(
      (service as any).validateConditionAvailability(
        tx,
        [
          {
            productId: 1,
            productName: 'Sản phẩm 1',
            quantity: 3,
            conditionType: 'near_expiry',
            soldExpiryDate: '2026-08-01',
          },
        ],
        2,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      (service as any).validateConditionAvailability(
        tx,
        [
          {
            productId: 1,
            productName: 'Sản phẩm 1',
            quantity: 4,
            conditionType: 'near_expiry',
            soldExpiryDate: null,
          },
        ],
        2,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      conditionType: 'damaged',
      soldExpiryDate: null,
      expected: { bucket: 'DAMAGED', expiryDate: undefined },
    },
    {
      conditionType: 'near_expiry',
      soldExpiryDate: '2026-08-20',
      expected: {
        bucket: 'NEAR_EXPIRY',
        expiryDate: new Date('2026-08-01T00:00:00.000Z'),
      },
    },
    {
      conditionType: 'near_expiry',
      soldExpiryDate: null,
      expected: { bucket: 'NEAR_EXPIRY', expiryDate: null },
    },
  ])('writes INTERNAL_USE for $conditionType', async (testCase) => {
    const service = createService();
    const create = jest.fn().mockResolvedValue(undefined);

    await (service as any).writeInternalUseConditionLog(
      { stockConditionLog: { create } },
      {
        detail: {
          productId: 1,
          productCode: 'SP1',
          productName: 'Sản phẩm 1',
          quantity: 2,
          conditionType: testCase.conditionType,
          soldExpiryDate: testCase.soldExpiryDate,
        },
        internalUse: {
          id: 10,
          code: 'XDNB000010',
          branchId: 2,
          branchName: 'Kho chính',
          transDate: new Date('2026-09-09T00:00:00.000Z'),
        },
        costPrice: 1000,
        actor: { userName: 'Tester' },
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transactionType: 'INTERNAL_USE',
        refType: 'internal_use',
        refId: 10,
        bucket: testCase.expected.bucket,
        quantity: -2,
        ...(testCase.expected.expiryDate !== undefined
          ? { expiryDate: testCase.expected.expiryDate }
          : {}),
      }),
    });
  });

  it('excludes condition logs after an internal-use voucher is cancelled', async () => {
    const tx = {
      stockConditionLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            quantity: 5,
            bucket: 'DAMAGED',
            refType: 'manual',
            refId: 1,
          },
          {
            quantity: -3,
            bucket: 'DAMAGED',
            refType: 'internal_use',
            refId: 10,
          },
        ]),
      },
      internalUse: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await expect(computeBucketTotals(tx, 1, 2)).resolves.toMatchObject({
      damaged: 5,
    });
  });
});
