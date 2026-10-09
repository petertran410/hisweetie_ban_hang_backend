import {
  recalcOnHandForPairs,
  recalcStockAuditChain,
} from './inventory-onhand.util';
import {
  recalcConditionBuckets,
  recalcConditionBucketsForPairs,
} from './stock-condition-onhand.util';

// Fake tx trong bộ nhớ: đủ để chạy cả bản từng-cặp lẫn bản theo-lô trên cùng
// một bộ dữ liệu rồi so kết quả.
const matchIn = (cond: any, value: any) =>
  cond && typeof cond === 'object' && 'in' in cond
    ? cond.in.includes(value)
    : cond === undefined || cond === value;

function buildDb() {
  const d = (s: string) => new Date(s);
  return {
    queries: 0,
    inventoryLogs: [
      // SP 1: bán, phiếu kiểm (anchor lệch), HĐ đã hủy, nhập
      {
        id: 1,
        productId: 1,
        branchId: 1,
        quantity: 100,
        refType: 'purchase_order',
        refId: 1,
        transactionType: 'PURCHASE',
        transactionDate: d('2026-01-01'),
        createdAt: d('2026-01-01'),
      },
      {
        id: 2,
        productId: 1,
        branchId: 1,
        quantity: -30,
        refType: 'invoice',
        refId: 10,
        transactionType: 'SALE',
        transactionDate: d('2026-01-02'),
        createdAt: d('2026-01-02'),
      },
      {
        id: 3,
        productId: 1,
        branchId: 1,
        quantity: -5,
        refType: 'stock_audit',
        refId: 50,
        transactionType: 'STOCK_AUDIT',
        transactionDate: d('2026-01-03'),
        createdAt: d('2026-01-03'),
      },
      {
        id: 4,
        productId: 1,
        branchId: 1,
        quantity: -20,
        refType: 'invoice',
        refId: 11,
        transactionType: 'SALE',
        transactionDate: d('2026-01-04'),
        createdAt: d('2026-01-04'),
      },
      {
        id: 5,
        productId: 1,
        branchId: 1,
        quantity: -7,
        refType: 'invoice',
        refId: 12,
        transactionType: 'SALE',
        transactionDate: d('2026-01-05'),
        createdAt: d('2026-01-05'),
      },
      // SP 2: cùng phiếu kiểm 50, log lùi ngày tạo sau nhưng đứng trước
      {
        id: 6,
        productId: 2,
        branchId: 1,
        quantity: 40,
        refType: 'purchase_order',
        refId: 1,
        transactionType: 'PURCHASE',
        transactionDate: d('2026-01-01'),
        createdAt: d('2026-01-01'),
      },
      {
        id: 7,
        productId: 2,
        branchId: 1,
        quantity: 2,
        refType: 'stock_audit',
        refId: 50,
        transactionType: 'STOCK_AUDIT',
        transactionDate: d('2026-01-03'),
        createdAt: d('2026-01-03'),
      },
      {
        id: 8,
        productId: 2,
        branchId: 1,
        quantity: -4,
        refType: 'invoice',
        refId: 10,
        transactionType: 'SALE',
        transactionDate: d('2026-01-02'),
        createdAt: d('2026-01-06'),
      },
      // SP 3: không có phiếu kiểm, có log lẻ không chứng từ
      {
        id: 9,
        productId: 3,
        branchId: 1,
        quantity: 12.5,
        refType: null,
        refId: null,
        transactionType: 'ADJUST',
        transactionDate: d('2026-01-01'),
        createdAt: d('2026-01-01'),
      },
      {
        id: 10,
        productId: 3,
        branchId: 1,
        quantity: -2.5,
        refType: 'invoice',
        refId: 11,
        transactionType: 'SALE',
        transactionDate: d('2026-01-02'),
        createdAt: d('2026-01-02'),
      },
      // SP 1 ở chi nhánh 2
      {
        id: 11,
        productId: 1,
        branchId: 2,
        quantity: 9,
        refType: 'transfer',
        refId: 7,
        transactionType: 'TRANSFER',
        transactionDate: d('2026-01-02'),
        createdAt: d('2026-01-02'),
      },
    ] as any[],
    stockAuditDetails: [
      {
        id: 501,
        stockAuditId: 50,
        productId: 1,
        actualQuantity: 60,
        costAtCheck: 1000,
        systemQuantity: 0,
        difference: 0,
        differenceValue: 0,
      },
      {
        id: 502,
        stockAuditId: 50,
        productId: 2,
        actualQuantity: 38,
        costAtCheck: 500,
        systemQuantity: 0,
        difference: 0,
        differenceValue: 0,
      },
    ] as any[],
    stockConditionLogs: [
      {
        productId: 1,
        branchId: 1,
        bucket: 'DAMAGED',
        quantity: 5,
        refType: 'clt',
        refId: 1,
      },
      {
        productId: 1,
        branchId: 1,
        bucket: 'DAMAGED',
        quantity: -2,
        refType: 'invoice',
        refId: 11,
      },
      {
        productId: 1,
        branchId: 1,
        bucket: 'PROMO',
        quantity: -3,
        refType: 'invoice',
        refId: 12,
      },
      {
        productId: 2,
        branchId: 1,
        bucket: 'NEAR_EXPIRY',
        quantity: 6,
        refType: 'clt',
        refId: 1,
      },
      {
        productId: 2,
        branchId: 1,
        bucket: 'PROMO',
        quantity: 4,
        refType: 'clt',
        refId: 2,
      },
      {
        productId: 1,
        branchId: 2,
        bucket: 'DAMAGED',
        quantity: 1,
        refType: null,
        refId: null,
      },
    ] as any[],
    inventories: [
      {
        productId: 1,
        branchId: 1,
        onHand: 0,
        totalWeight: 0,
        damagedQuantity: 0,
        nearExpiryQuantity: 0,
        promoQuantity: 0,
        product: { weight: 0.5 },
      },
      {
        productId: 2,
        branchId: 1,
        onHand: 0,
        totalWeight: 0,
        damagedQuantity: 0,
        nearExpiryQuantity: 0,
        promoQuantity: 0,
        product: { weight: null },
      },
      {
        productId: 3,
        branchId: 1,
        onHand: 10,
        totalWeight: 20,
        damagedQuantity: 0,
        nearExpiryQuantity: 0,
        promoQuantity: 0,
        product: { weight: 2 },
      },
      {
        productId: 1,
        branchId: 2,
        onHand: 0,
        totalWeight: 0,
        damagedQuantity: 0,
        nearExpiryQuantity: 0,
        promoQuantity: 0,
        product: { weight: 0.5 },
      },
    ] as any[],
    // chứng từ còn hiệu lực
    active: {
      invoice: [10, 11], // 12 đã hủy
      purchaseOrder: [1],
      stockAudit: [50],
      transfer: [7],
      stockConditionTransfer: [1], // clt 2 chưa duyệt
    } as Record<string, number[]>,
  };
}

function buildTx(db: ReturnType<typeof buildDb>) {
  const activeModel = (name: string) => ({
    findMany: async ({ where }: any) => {
      db.queries++;
      return (db.active[name] || [])
        .filter((id) => where.id.in.includes(id))
        .map((id) => ({ id }));
    },
  });
  const findInv = (where: any) =>
    db.inventories.find(
      (i) =>
        i.productId === where.productId_branchId.productId &&
        i.branchId === where.productId_branchId.branchId,
    );
  const tx: any = new Proxy(
    {
      inventoryLog: {
        findMany: async ({ where }: any) => {
          db.queries++;
          return db.inventoryLogs
            .filter(
              (l) =>
                matchIn(where.productId, l.productId) &&
                l.branchId === where.branchId,
            )
            .sort(
              (a, b) =>
                a.transactionDate - b.transactionDate ||
                a.createdAt - b.createdAt ||
                a.id - b.id,
            )
            .map((l) => ({ ...l }));
        },
        update: async ({ where, data }: any) => {
          db.queries++;
          Object.assign(
            db.inventoryLogs.find((l) => l.id === where.id),
            data,
          );
        },
      },
      stockAuditDetail: {
        findMany: async ({ where }: any) => {
          db.queries++;
          return db.stockAuditDetails
            .filter(
              (x) =>
                where.stockAuditId.in.includes(x.stockAuditId) &&
                matchIn(where.productId, x.productId),
            )
            .map((x) => ({ ...x }));
        },
        update: async ({ where, data }: any) => {
          db.queries++;
          Object.assign(
            db.stockAuditDetails.find((x) => x.id === where.id),
            data,
          );
        },
      },
      stockConditionLog: {
        findMany: async ({ where }: any) => {
          db.queries++;
          return db.stockConditionLogs.filter(
            (l) =>
              matchIn(where.productId, l.productId) &&
              l.branchId === where.branchId,
          );
        },
      },
      inventory: {
        findUnique: async ({ where }: any) => {
          db.queries++;
          const inv = findInv(where);
          return inv ? { id: 1, ...inv } : null;
        },
        findMany: async ({ where }: any) => {
          db.queries++;
          return db.inventories
            .filter(
              (i) =>
                matchIn(where.productId, i.productId) &&
                i.branchId === where.branchId,
            )
            .map((i) => ({ ...i }));
        },
        update: async ({ where, data }: any) => {
          db.queries++;
          Object.assign(findInv(where), data);
        },
      },
    } as any,
    {
      get: (target, prop: string) => target[prop] ?? activeModel(prop),
    },
  );
  return tx;
}

const PAIRS = [
  { productId: 1, branchId: 1 },
  { productId: 2, branchId: 1 },
  { productId: 1, branchId: 1 }, // trùng
  { productId: 3, branchId: 1 },
  { productId: 1, branchId: 2 },
  { productId: 99, branchId: 1 }, // không có tồn kho / log
  { productId: null, branchId: 1 },
];

const snapshot = (db: ReturnType<typeof buildDb>) => ({
  inventories: db.inventories,
  inventoryLogs: db.inventoryLogs.map((l) => [l.id, l.quantity]),
  stockAuditDetails: db.stockAuditDetails,
});

describe('recalc tồn kho theo lô', () => {
  it('recalcOnHandForPairs cho kết quả giống recalcStockAuditChain từng cặp', async () => {
    const single = buildDb();
    const singleTx = buildTx(single);
    for (const p of PAIRS) {
      if (p.productId == null) continue;
      await recalcStockAuditChain(singleTx, p.productId, p.branchId);
    }

    const batch = buildDb();
    await recalcOnHandForPairs(buildTx(batch), PAIRS);

    expect(snapshot(batch)).toEqual(snapshot(single));
    // re-anchor phiếu kiểm: SP1 = 60 − 20 (HĐ 12 đã hủy bị loại), SP2 = 38
    expect(batch.inventories.map((i) => Number(i.onHand))).toEqual([
      40, 38, 10, 9,
    ]);
    expect(batch.queries).toBeLessThan(single.queries);
  });

  it('recalcConditionBucketsForPairs cho kết quả giống recalcConditionBuckets từng cặp', async () => {
    const single = buildDb();
    const singleTx = buildTx(single);
    for (const p of PAIRS) {
      if (p.productId == null) continue;
      await recalcConditionBuckets(singleTx, p.productId, p.branchId);
    }

    const batch = buildDb();
    await recalcConditionBucketsForPairs(buildTx(batch), PAIRS);

    expect(batch.inventories).toEqual(single.inventories);
    expect(batch.inventories[0]).toMatchObject({
      damagedQuantity: 3,
      nearExpiryQuantity: 0,
      promoQuantity: 0,
    });
    expect(batch.queries).toBeLessThan(single.queries);
  });

  it('không ghi tồn kho khi số liệu không đổi', async () => {
    const db = buildDb();
    const tx = buildTx(db);
    await recalcOnHandForPairs(tx, PAIRS);
    const update = jest.spyOn(tx.inventory, 'update');
    await recalcOnHandForPairs(tx, PAIRS);
    expect(update).not.toHaveBeenCalled();
  });
});
