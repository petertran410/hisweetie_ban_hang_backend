import {
  derivePeriod,
  isoWeekOf,
  isoWeekRange,
  isoWeeksInYear,
  periodLabel,
  refundDueKey,
  vnDateKey,
} from './cash-advance-period';

describe('cash-advance-period', () => {
  it('computes ISO weeks Monday–Sunday', () => {
    expect(isoWeekRange(2026, 43)).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
    });
    expect(isoWeekOf('2026-10-22')).toEqual({ year: 2026, week: 43 });
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeekRange(2026, 53)).toEqual({
      from: '2026-12-28',
      to: '2027-01-03',
    });
    expect(isoWeekRange(2027, 1)).toEqual({
      from: '2027-01-04',
      to: '2027-01-10',
    });
  });

  it('derives the period on the server for week mode', () => {
    expect(
      derivePeriod({
        periodMode: 'WEEK',
        periodYear: 2026,
        periodWeek: 43,
        // Ngày client gửi kèm bị bỏ qua.
        periodFrom: '2026-01-01',
      }),
    ).toEqual({
      mode: 'WEEK',
      year: 2026,
      week: 43,
      from: '2026-10-19',
      to: '2026-10-25',
    });
    expect(() =>
      derivePeriod({ periodMode: 'WEEK', periodYear: 2027, periodWeek: 53 }),
    ).toThrow('Tuần');
  });

  it('validates custom ranges', () => {
    expect(
      derivePeriod({
        periodMode: 'RANGE',
        periodFrom: '2026-10-19',
        periodTo: '2026-10-22',
      }),
    ).toMatchObject({ from: '2026-10-19', to: '2026-10-22', week: null });
    expect(() =>
      derivePeriod({
        periodMode: 'RANGE',
        periodFrom: '2026-10-25',
        periodTo: '2026-10-19',
      }),
    ).toThrow('Từ ngày');
    expect(() =>
      derivePeriod({
        periodMode: 'RANGE',
        periodFrom: '2026-01-01',
        periodTo: '2026-12-31',
      }),
    ).toThrow('tối đa');
  });

  it('gives 5 grace days after the period', () => {
    expect(refundDueKey('2026-10-25')).toBe('2026-10-30');
    expect(refundDueKey('2026-12-29')).toBe('2027-01-03');
  });

  it('reads instants in Vietnam time', () => {
    expect(vnDateKey(new Date('2026-10-25T16:59:59Z'))).toBe('2026-10-25');
    expect(vnDateKey(new Date('2026-10-25T17:00:00Z'))).toBe('2026-10-26');
    expect(vnDateKey('2026-10-25T00:00:00+07:00')).toBe('2026-10-25');
  });

  it('labels periods', () => {
    expect(
      periodLabel({
        periodMode: 'WEEK',
        periodYear: 2026,
        periodWeek: 43,
        periodFrom: new Date('2026-10-19T00:00:00Z'),
        periodTo: new Date('2026-10-25T00:00:00Z'),
      }),
    ).toBe('Tuần 43/2026 (19/10 – 25/10/2026)');
    expect(
      periodLabel({
        periodMode: 'RANGE',
        periodFrom: new Date('2026-10-19T00:00:00Z'),
        periodTo: new Date('2026-10-22T00:00:00Z'),
      }),
    ).toBe('19/10/2026 – 22/10/2026');
  });
});
