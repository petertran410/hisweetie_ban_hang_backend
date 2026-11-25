import { overdueItems, togetherItems } from './upsell.service';

const NOW = new Date('2026-11-23T03:00:00Z');
const d = (s: string) => new Date(`${s}T03:00:00Z`);

describe('overdueItems (chu kỳ = trung vị khoảng cách, trễ > 1,2 × chu kỳ)', () => {
  it('món mua đều 10 ngày/lần, 20 ngày chưa mua → trễ', () => {
    const purchases = [
      '2026-10-04',
      '2026-10-14',
      '2026-10-24',
      '2026-11-03',
    ].map((x) => ({
      productId: 1,
      date: d(x),
    }));
    expect(overdueItems(purchases, NOW)).toEqual([
      {
        productId: 1,
        lastDate: '2026-11-03',
        cycleDays: 10,
        daysSince: 20,
        times: 4,
      },
    ]);
  });
  it('chưa tới hạn, hoặc mua < 3 ngày khác nhau → không gợi ý', () => {
    const due = ['2026-10-23', '2026-11-02', '2026-11-12', '2026-11-20'].map(
      (x) => ({ productId: 2, date: d(x) }),
    );
    const few = ['2026-09-01', '2026-09-01', '2026-10-01'].map((x) => ({
      productId: 3,
      date: d(x),
    }));
    expect(overdueItems([...due, ...few], NOW)).toEqual([]);
  });
  it('trễ quá lâu (> 4 chu kỳ hoặc > 120 ngày) coi như đã bỏ → không gợi ý', () => {
    const stopped = ['2026-04-01', '2026-04-08', '2026-04-15'].map((x) => ({
      productId: 7,
      date: d(x),
    }));
    expect(overdueItems(stopped, NOW)).toEqual([]);
  });
  it('xếp theo mức trễ so với chu kỳ', () => {
    const a = ['2026-08-01', '2026-08-31', '2026-09-30'].map((x) => ({
      productId: 10,
      date: d(x),
    })); // 30 ngày, trễ ~54
    const b = ['2026-10-20', '2026-10-25', '2026-10-30'].map((x) => ({
      productId: 11,
      date: d(x),
    })); // 5 ngày, trễ 24
    expect(overdueItems([...a, ...b], NOW).map((x) => x.productId)).toEqual([
      11, 10,
    ]);
  });
});

describe('togetherItems', () => {
  // Món 1 (mứt) hay đi kèm món 2 (siro); món 3 phổ biến khắp nơi (lift thấp)
  const baskets = new Map<number, Set<number>>();
  let id = 0;
  for (let i = 0; i < 10; i++) baskets.set(++id, new Set([1, 2, 3]));
  for (let i = 0; i < 40; i++) baskets.set(++id, new Set([3, 4]));
  for (let i = 0; i < 10; i++) baskets.set(++id, new Set([5]));

  it('gợi ý món hay đi kèm mà khách chưa mua, theo lift', () => {
    const result = togetherItems(baskets, [1], new Set([1]));
    expect(result.map((r) => r.productId)).toEqual([2]);
    expect(result[0]).toMatchObject({ withId: 1, confidence: 1 });
  });
  it('bỏ món khách đã mua và cặp dưới 5 hoá đơn', () => {
    expect(togetherItems(baskets, [1], new Set([1, 2]))).toEqual([]);
    expect(
      togetherItems(new Map([[1, new Set([1, 9])]]), [1], new Set([1])),
    ).toEqual([]);
  });
});
