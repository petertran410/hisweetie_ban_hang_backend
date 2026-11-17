import type { Prisma } from '@prisma/client';
import { fillMissingPricesFromCost } from './fill-missing-prices.util';

type Db = Pick<Prisma.TransactionClient, 'inventory'>;

function mockDb(rows: Array<{ productId: number; cost: number }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const db = { inventory: { findMany } } as unknown as Db;
  return { db, findMany };
}

describe('fillMissingPricesFromCost', () => {
  it('giữ nguyên dòng đã có giá (kể cả giá 0) và không truy vấn', async () => {
    const { db, findMany } = mockDb([]);
    const result = await fillMissingPricesFromCost(
      db,
      [
        { productId: 1, price: 12000 },
        { productId: 2, price: 0 },
      ],
      5,
    );
    expect(result.map((r) => r.price)).toEqual([12000, 0]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('dòng thiếu giá lấy giá vốn chi nhánh, 1 truy vấn cho mọi dòng', async () => {
    const { db, findMany } = mockDb([
      { productId: 2, cost: 45000 },
      { productId: 3, cost: 7000 },
    ]);
    const result = await fillMissingPricesFromCost(
      db,
      [
        { productId: 1, price: 10000 },
        { productId: 2 },
        { productId: 3, price: null },
        { productId: 2 },
      ],
      5,
    );
    expect(result.map((r) => r.price)).toEqual([10000, 45000, 7000, 45000]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { branchId: 5, productId: { in: [2, 3] } },
      select: { productId: true, cost: true },
    });
  });

  it('không có chi nhánh → không truy vấn, giá = 0', async () => {
    const { db, findMany } = mockDb([{ productId: 1, cost: 999 }]);
    const result = await fillMissingPricesFromCost(
      db,
      [{ productId: 1 }],
      undefined,
    );
    expect(result[0].price).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('sản phẩm chưa có tồn kho ở chi nhánh → 0', async () => {
    const { db } = mockDb([]);
    const result = await fillMissingPricesFromCost(db, [{ productId: 9 }], 5);
    expect(result[0].price).toBe(0);
  });

  it('giữ các trường khác của dòng', async () => {
    const { db } = mockDb([{ productId: 4, cost: 100 }]);
    const [row] = await fillMissingPricesFromCost(
      db,
      [{ productId: 4, quantity: 3, note: 'x' }],
      1,
    );
    expect(row).toEqual({ productId: 4, quantity: 3, note: 'x', price: 100 });
  });
});
