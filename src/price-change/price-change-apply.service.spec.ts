import { buildApplyPlan } from './price-change-apply.service';

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    ticketId: 1,
    sort: 0,
    productId: 10,
    productCode: 'SP10',
    productName: 'Siro',
    costs: [
      { branchId: 6, branchName: 'Kho Hà Nội', oldCost: 100, newCost: 120 },
      { branchId: 1, branchName: 'Kho Sài Gòn', oldCost: 100, newCost: null },
    ],
    prices: [
      {
        priceBookId: 0,
        priceBookName: 'Bảng giá chung',
        oldPrice: 200,
        newPrice: 210,
      },
      {
        priceBookId: 3,
        priceBookName: 'Buôn HN',
        oldPrice: null,
        newPrice: 190,
      },
    ],
    ...over,
  }) as any;

const current = (over: Record<string, unknown> = {}) => ({
  productId: 10,
  code: 'SP10',
  name: 'Siro',
  unit: null,
  isActive: true,
  type: 2,
  costs: { 6: 100, 1: 100 },
  prices: { 0: 200, 3: null },
  ...over,
});

describe('buildApplyPlan', () => {
  it('chỉ ghi ô có giá mới; ô chưa có trong bảng giá → tạo mới', () => {
    const plan = buildApplyPlan(
      [item()],
      [current()],
      new Set([6, 1]),
      new Set([3]),
    );
    expect(plan.ok).toBe(true);
    expect(plan.counts).toEqual({ products: 1, costCells: 1, priceCells: 2 });
    const book = plan.rows[0].cells.find((c) => c.targetId === 3)!;
    expect(book.createsRow).toBe(true);
    expect(plan.issues).toEqual([]);
  });

  it('cảnh báo khi giá hiện tại đã khác lúc đề xuất', () => {
    const plan = buildApplyPlan(
      [item()],
      [current({ costs: { 6: 105, 1: 100 } })],
      new Set([6, 1]),
      new Set([3]),
    );
    expect(plan.ok).toBe(true);
    expect(plan.rows[0].cells[0].changedSinceProposal).toBe(true);
    expect(plan.issues[0]).toMatchObject({ severity: 'warning' });
    expect(plan.issues[0].message).toMatch(
      /đã khác lúc đề xuất \(Kho Hà Nội\)/,
    );
  });

  it('chặn khi sản phẩm ngừng kinh doanh, chưa khớp, bảng giá ngừng hoạt động', () => {
    expect(
      buildApplyPlan(
        [item()],
        [current({ isActive: false })],
        new Set([6]),
        new Set([3]),
      ).ok,
    ).toBe(false);
    const unmatched = buildApplyPlan(
      [item({ productId: null })],
      [],
      new Set([6]),
      new Set([3]),
    );
    expect(unmatched.ok).toBe(false);
    expect(unmatched.issues[0].message).toMatch(/chưa khớp/);
    const inactiveBook = buildApplyPlan(
      [item()],
      [current()],
      new Set([6]),
      new Set(),
    );
    expect(inactiveBook.ok).toBe(false);
    expect(inactiveBook.issues.map((i) => i.message).join('|')).toMatch(
      /Bảng giá "Buôn HN" không còn hoạt động/,
    );
  });

  it('cảnh báo hàng combo và chi nhánh chưa có dòng tồn kho', () => {
    const plan = buildApplyPlan(
      [item()],
      [current({ type: 1, costs: { 6: null, 1: 100 } })],
      new Set([6, 1]),
      new Set([3]),
    );
    const msgs = plan.issues.map((i) => i.message).join('|');
    expect(plan.ok).toBe(true);
    expect(msgs).toMatch(/combo/);
    expect(msgs).toMatch(/chưa có dòng tồn kho tại Kho Hà Nội/);
  });
});
