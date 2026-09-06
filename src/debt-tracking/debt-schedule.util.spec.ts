import {
  computeCustomerAging,
  resolveFixedSchedule,
} from './debt-aging.util';

describe('fixed debt payment schedules', () => {
  it('uses the last day of February for a monthly day 31', () => {
    const result = resolveFixedSchedule(
      { paymentScheduleType: 'MONTHLY', paymentScheduleDays: [31] },
      new Date('2026-03-02T12:00:00'),
    );

    expect(result.dueDate).toEqual(new Date('2026-02-28T00:00:00'));
  });

  it('marks a fixed monthly date overdue after five grace days', () => {
    const result = computeCustomerAging(
      1000,
      [],
      {
        debtRuleType: 'MONTHLY_SCHEDULE',
        hasCreditLimit: false,
        hasTermDays: false,
        paymentScheduleType: 'MONTHLY',
        paymentScheduleDays: [15],
      },
      new Date('2026-09-21T12:00:00'),
    );

    expect(result.overdueAmount).toBe(1000);
    expect(result.invoiceRequiredAmount).toBe(1000);
    expect(result.debtStatus).toBe('OVERDUE');
  });

  it('supports multiple weekly payment days', () => {
    const result = resolveFixedSchedule(
      { paymentScheduleType: 'WEEKLY', paymentScheduleDays: [1, 4] },
      new Date('2026-09-09T12:00:00'),
    );

    expect(result.dueDate).toEqual(new Date('2026-09-07T00:00:00'));
  });
});
