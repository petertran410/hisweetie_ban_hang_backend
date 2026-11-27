import { cellDiff, summarizeItems } from './price-change.calc';

describe('price-change calc', () => {
  it('chênh lệch và tỷ lệ = (mới − cũ) / cũ', () => {
    expect(cellDiff(100, 110)).toEqual({ diff: 10, ratio: 0.1 });
    expect(cellDiff(200, 150)).toEqual({ diff: -50, ratio: -0.25 });
  });

  it('không có giá mới hoặc giá cũ → không tính; giá cũ 0 → không có tỷ lệ', () => {
    expect(cellDiff(100, null)).toEqual({ diff: null, ratio: null });
    expect(cellDiff(null, 100)).toEqual({ diff: null, ratio: null });
    expect(cellDiff(0, 100)).toEqual({ diff: 100, ratio: null });
  });

  it('tóm tắt số ô đổi và tăng / giảm', () => {
    const s = summarizeItems([
      {
        costs: [
          { branchId: 1, branchName: 'A', oldCost: 100, newCost: 120 },
          { branchId: 2, branchName: 'B', oldCost: 100, newCost: null },
        ],
        prices: [
          { priceBookId: 0, priceBookName: 'C', oldPrice: 200, newPrice: 180 },
        ],
      },
    ]);
    expect(s).toEqual({
      productCount: 1,
      costCells: 1,
      priceCells: 1,
      increases: 1,
      decreases: 1,
    });
  });
});
