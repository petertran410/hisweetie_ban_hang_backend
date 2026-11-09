import {
  localBucketLabel,
  ratePct,
  toHeatCells,
  trendTrunc,
} from './dashboard-buckets';

describe('trendTrunc', () => {
  it('kỳ có sẵn: hôm nay/hôm qua theo giờ, còn lại theo ngày', () => {
    expect(trendTrunc('today', 0.5)).toBe('hour');
    expect(trendTrunc('yesterday', 1)).toBe('hour');
    expect(trendTrunc('week', 7)).toBe('day');
    expect(trendTrunc('lastMonth', 31)).toBe('day');
  });

  it('khoảng tự chọn: ≤ 1 ngày theo giờ, ≤ 92 ngày theo ngày, dài hơn theo tháng', () => {
    expect(trendTrunc('custom', 0.99)).toBe('hour');
    expect(trendTrunc('custom', 30)).toBe('day');
    expect(trendTrunc('custom', 92)).toBe('day');
    expect(trendTrunc('custom', 120)).toBe('month');
  });
});

describe('localBucketLabel', () => {
  // Mốc đã là giờ Việt Nam, Prisma trả như UTC.
  const d = new Date(Date.UTC(2026, 10, 5, 9, 0, 0));

  it('đọc theo UTC nên không lệch múi giờ máy chủ', () => {
    expect(localBucketLabel(d, 'hour')).toBe('09');
    expect(localBucketLabel(d, 'day')).toBe('05/11');
    expect(localBucketLabel(d, 'month')).toBe('11/2026');
  });
});

describe('toHeatCells', () => {
  it('đổi số và bỏ hàng sai', () => {
    expect(
      toHeatCells([
        { dow: '1', hour: '9', revenue: '1500000', cnt: '3' },
        { dow: 7, hour: 9, revenue: 1, cnt: 1 },
        { dow: 2, hour: 24, revenue: 1, cnt: 1 },
        { dow: 0, hour: 23, revenue: null, cnt: null },
      ]),
    ).toEqual([
      { dow: 1, hour: 9, revenue: 1500000, count: 3 },
      { dow: 0, hour: 23, revenue: 0, count: 0 },
    ]);
  });
});

describe('ratePct', () => {
  it('làm tròn 1 chữ số, mẫu số 0 thì 0', () => {
    expect(ratePct(1, 3)).toBe(33.3);
    expect(ratePct(5, 0)).toBe(0);
  });
});
