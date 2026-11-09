import {
  compareWindow,
  currentPeriod,
  daxDate,
  edate,
  isoWeekday,
  listDates,
  sameYearRange,
  shiftYear,
  todayVn,
} from './analytics-period';

describe('analytics-period (logic DAX của Power BI)', () => {
  it('daxDate tự tràn như DATE() của DAX', () => {
    expect(daxDate(2025, 2, 29)).toBe('2025-03-01');
    expect(daxDate(2026, 13, 1)).toBe('2027-01-01');
    expect(daxDate(2026, 3, 0)).toBe('2026-02-28');
  });

  it('edate kẹp về cuối tháng', () => {
    expect(edate('2026-03-31', -1)).toBe('2026-02-28');
    expect(edate('2024-03-31', -1)).toBe('2024-02-29');
    expect(edate('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('todayVn cộng 7 giờ', () => {
    expect(todayVn(new Date('2026-11-05T17:30:00Z'))).toBe('2026-11-06');
    expect(todayVn(new Date('2026-11-05T16:59:00Z'))).toBe('2026-11-05');
  });

  it('chọn 1 tháng đủ 31 ngày: so với tháng trước, nhãn MM/yyyy', () => {
    const p = currentPeriod({ year: 2026, months: [3] }, '2026-11-06')!;
    expect(p).toMatchObject({
      min: '2026-03-01',
      max: '2026-03-31',
      hasMonthFilter: true,
    });
    expect(compareWindow(p)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      label: '02/2026',
    });
  });

  it('tháng hiện tại tính đến hôm nay', () => {
    const p = currentPeriod({ year: 2026, months: [11] }, '2026-11-06')!;
    expect(p).toMatchObject({ min: '2026-11-01', max: '2026-11-06' });
    expect(compareWindow(p)).toEqual({
      from: '2026-10-01',
      to: '2026-10-06',
      label: '10/2026',
    });
  });

  it('cả năm đã qua: so cùng số ngày từ cùng ngày năm trước', () => {
    const p = currentPeriod({ year: 2025, months: [] }, '2026-11-06')!;
    expect(p.hasMonthFilter).toBe(false);
    // 2025-01-01..2025-12-31 = 364 ngày chênh → 2024-01-01 + 364 = 2024-12-30 (đúng quirk DAX)
    expect(compareWindow(p)).toEqual({
      from: '2024-01-01',
      to: '2024-12-30',
      label: '2024',
    });
  });

  it('năm hiện tại = từ đầu năm tới hôm nay, so cùng kỳ năm trước', () => {
    const p = currentPeriod({ year: 2026, months: [] }, '2026-11-06')!;
    expect(p).toMatchObject({
      min: '2026-01-01',
      max: '2026-11-06',
      hasMonthFilter: false,
    });
    expect(p.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(compareWindow(p)).toEqual({
      from: '2025-01-01',
      to: '2025-11-06',
      label: '2025',
    });
  });

  it('năm hiện tại vào tháng 1 → chỉ còn 1 tháng → so tháng trước', () => {
    const p = currentPeriod({ year: 2026, months: [] }, '2026-01-10')!;
    expect(p.hasMonthFilter).toBe(true);
    expect(compareWindow(p)).toEqual({
      from: '2025-12-01',
      to: '2025-12-10',
      label: '12/2025',
    });
  });

  it('nhiều tháng không liền nhau: kỳ so sánh là cả khoảng min..max', () => {
    const p = currentPeriod({ year: 2026, months: [1, 3] }, '2026-11-06')!;
    expect(compareWindow(p)).toEqual({
      from: '2025-01-01',
      to: '2025-03-31',
      label: '2025',
    });
  });

  it('năm tương lai → không có kỳ', () => {
    expect(currentPeriod({ year: 2027, months: [] }, '2026-11-06')).toBeNull();
  });

  it('sameYearRange của tháng 2 năm nhuận lấn sang 1/3 (quirk DAX)', () => {
    expect(sameYearRange('2024-02-01', '2024-02-29')).toEqual({
      from: '2023-02-01',
      to: '2023-03-01',
    });
  });

  it('shiftYear, listDates, isoWeekday', () => {
    expect(shiftYear('2024-02-29')).toBe('2023-03-01');
    const p = currentPeriod({ year: 2026, months: [11] }, '2026-11-03')!;
    expect(listDates(p, 2026)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(isoWeekday('2026-11-01')).toBe(7); // Chủ nhật
    expect(isoWeekday('2026-11-02')).toBe(1); // Thứ 2
  });
});
