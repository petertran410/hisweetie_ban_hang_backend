import {
  financeOwnedCashFlowIds,
  financeOwnedInvoiceIds,
} from './finance-owned-cash-flows';

describe('finance-owned cash flows (invoice import guard)', () => {
  type Db = Parameters<typeof financeOwnedCashFlowIds>[0];
  const makeDb = (direct: number[], posted: Array<number | string>) => {
    const findMany = jest
      .fn()
      .mockResolvedValue(direct.map((cashFlowId) => ({ cashFlowId })));
    const queryRaw = jest
      .fn()
      .mockResolvedValue(posted.map((id) => ({ id: String(id) })));
    const db = {
      internalFinanceEntry: { findMany },
      $queryRaw: queryRaw,
    } as unknown as Db;
    return { db, findMany, queryRaw };
  };

  it('finds cash flows linked by cashFlowId or listed in postedCashFlows', async () => {
    const { db, findMany } = makeDb([9], [10, 99]);
    const owned = await financeOwnedCashFlowIds(db, [9, 10, 11, 9]);
    expect([...owned].sort()).toEqual([10, 9]);
    expect(findMany).toHaveBeenCalledWith({
      where: { cashFlowId: { in: [9, 10, 11] } },
      select: { cashFlowId: true },
    });
  });

  it('does not query when there is no cash flow', async () => {
    const { db, findMany, queryRaw } = makeDb([], []);
    expect((await financeOwnedCashFlowIds(db, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('blocks every invoice paid by a finance-owned cash flow', async () => {
    const { db } = makeDb([9], [10]);
    const blocked = await financeOwnedInvoiceIds(db, [
      { invoiceId: 1, cashFlowId: 9 },
      { invoiceId: 2, cashFlowId: 9 },
      { invoiceId: 3, cashFlowId: 10 },
      { invoiceId: 4, cashFlowId: 11 },
      { invoiceId: 5, cashFlowId: null },
    ]);
    expect([...blocked].sort()).toEqual([1, 2, 3]);
  });
});
