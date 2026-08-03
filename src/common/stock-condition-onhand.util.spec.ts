import {
  BUCKET_DAMAGED,
  BUCKET_NEAR_EXPIRY,
  BUCKET_PROMO,
  computeBucketTotals,
  computeNearExpiryLots,
  writeConditionLogs,
} from './stock-condition-onhand.util';

describe('stock-condition-onhand util', () => {
  describe('writeConditionLogs', () => {
    const base = {
      productId: 101,
      productCode: 'SP-TEST',
      productName: 'Sản phẩm test',
      branchId: 6,
      branchName: 'Kho test',
      refCode: 'REF-001',
      refType: 'test_ref',
      refId: 99,
    };

    it.each([
      {
        name: 'nhập hàng NCC loại B',
        transactionType: 'PURCHASE_IN',
        refType: 'purchase_order',
        values: { damaged: 10 },
        expected: { bucket: BUCKET_DAMAGED, quantity: 10 },
      },
      {
        name: 'khách trả hàng bục rách',
        transactionType: 'RETURN_IN',
        refType: 'return_order',
        values: { damaged: 3 },
        expected: { bucket: BUCKET_DAMAGED, quantity: 3 },
      },
      {
        name: 'trả NCC hàng cận date',
        transactionType: 'SUPPLIER_RETURN_OUT',
        refType: 'supplier_return',
        values: { nearExpiry: -4 },
        expected: { bucket: BUCKET_NEAR_EXPIRY, quantity: -4 },
      },
      {
        name: 'hoàn ký gửi hàng bục rách',
        transactionType: 'CONSIGNMENT_RETURN_IN',
        refType: 'consignment_return',
        values: { damaged: 5 },
        expected: { bucket: BUCKET_DAMAGED, quantity: 5 },
      },
    ])(
      'ghi đúng log khi $name',
      async ({ transactionType, refType, values, expected }) => {
        const create = jest.fn().mockResolvedValue(undefined);
        const tx = { stockConditionLog: { create } };

        await writeConditionLogs(tx, {
          ...base,
          refType,
          transactionType,
          ...values,
        });

        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            transactionType,
            refType,
            bucket: expected.bucket,
            quantity: expected.quantity,
          }),
        });
      },
    );

    it('ghi hai bucket cho một lần khách trả hàng', async () => {
      const create = jest.fn().mockResolvedValue(undefined);
      const tx = { stockConditionLog: { create } };

      await writeConditionLogs(tx, {
        ...base,
        refType: 'return_order',
        transactionType: 'RETURN_IN',
        damaged: 2,
        nearExpiry: 3,
      });

      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls.map(([arg]) => arg.data)).toEqual([
        expect.objectContaining({ bucket: BUCKET_DAMAGED, quantity: 2 }),
        expect.objectContaining({ bucket: BUCKET_NEAR_EXPIRY, quantity: 3 }),
      ]);
    });

    it('giữ đúng lô NSX khi hoàn hàng ký gửi cận date', async () => {
      const create = jest.fn().mockResolvedValue(undefined);
      const tx = { stockConditionLog: { create } };
      const manufactureDate = new Date('2026-08-01T00:00:00.000Z');

      await writeConditionLogs(tx, {
        ...base,
        refType: 'consignment_return',
        transactionType: 'CONSIGNMENT_RETURN_IN',
        nearExpiry: 7,
        nearExpiryDate: manufactureDate,
      });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bucket: BUCKET_NEAR_EXPIRY,
          quantity: 7,
          expiryDate: manufactureDate,
        }),
      });
    });

    it('bỏ qua bucket có quantity bằng 0', async () => {
      const create = jest.fn().mockResolvedValue(undefined);
      const tx = { stockConditionLog: { create } };

      await writeConditionLogs(tx, {
        ...base,
        transactionType: 'RETURN_IN',
        damaged: 0,
        nearExpiry: 0,
        promo: 0,
      });

      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('active document filtering', () => {
    it('chỉ cộng log của chứng từ còn hiệu lực', async () => {
      const logs = [
        { quantity: 10, bucket: BUCKET_DAMAGED, refType: 'clt', refId: 1 },
        { quantity: 50, bucket: BUCKET_DAMAGED, refType: 'clt', refId: 2 },
        { quantity: -2, bucket: BUCKET_DAMAGED, refType: 'invoice', refId: 10 },
        {
          quantity: -30,
          bucket: BUCKET_DAMAGED,
          refType: 'invoice',
          refId: 11,
        },
        {
          quantity: 4,
          bucket: BUCKET_NEAR_EXPIRY,
          refType: 'purchase_order',
          refId: 20,
        },
        {
          quantity: 40,
          bucket: BUCKET_NEAR_EXPIRY,
          refType: 'purchase_order',
          refId: 21,
        },
        {
          quantity: 3,
          bucket: BUCKET_PROMO,
          refType: 'return_order',
          refId: 30,
        },
        {
          quantity: 30,
          bucket: BUCKET_PROMO,
          refType: 'return_order',
          refId: 31,
        },
        {
          quantity: -1,
          bucket: BUCKET_DAMAGED,
          refType: 'supplier_return',
          refId: 40,
        },
        {
          quantity: -10,
          bucket: BUCKET_DAMAGED,
          refType: 'supplier_return',
          refId: 41,
        },
        {
          quantity: 2,
          bucket: BUCKET_NEAR_EXPIRY,
          refType: 'consignment_return',
          refId: 50,
        },
        {
          quantity: 20,
          bucket: BUCKET_NEAR_EXPIRY,
          refType: 'consignment_return',
          refId: 51,
        },
      ];
      const tx = {
        stockConditionLog: { findMany: jest.fn().mockResolvedValue(logs) },
        stockConditionTransfer: {
          findMany: jest.fn().mockResolvedValue([{ id: 1 }]),
        },
        invoice: { findMany: jest.fn().mockResolvedValue([{ id: 10 }]) },
        purchaseOrder: { findMany: jest.fn().mockResolvedValue([{ id: 20 }]) },
        returnOrder: { findMany: jest.fn().mockResolvedValue([{ id: 30 }]) },
        supplierReturn: { findMany: jest.fn().mockResolvedValue([{ id: 40 }]) },
        consignmentReturn: {
          findMany: jest.fn().mockResolvedValue([{ id: 50 }]),
        },
      };

      await expect(computeBucketTotals(tx, 101, 6)).resolves.toEqual({
        damaged: 7,
        nearExpiry: 6,
        promo: 3,
      });
    });

    it('lọc lô hết tồn và sắp NSX cũ nhất trước, lô null cuối', async () => {
      const logs = [
        {
          quantity: 5,
          expiryDate: new Date('2026-09-01T00:00:00.000Z'),
          refType: 'manual',
          refId: 1,
        },
        {
          quantity: 3,
          expiryDate: new Date('2026-08-01T00:00:00.000Z'),
          refType: 'manual',
          refId: 2,
        },
        {
          quantity: -3,
          expiryDate: new Date('2026-08-01T00:00:00.000Z'),
          refType: 'manual',
          refId: 3,
        },
        { quantity: 2, expiryDate: null, refType: 'manual', refId: 4 },
      ];
      const tx = {
        stockConditionLog: { findMany: jest.fn().mockResolvedValue(logs) },
      };

      await expect(computeNearExpiryLots(tx, 101, 6)).resolves.toEqual([
        { expiryDate: '2026-09-01', quantity: 5 },
        { expiryDate: null, quantity: 2 },
      ]);
    });
  });
});
