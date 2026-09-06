import {
  computeCustomerAging,
  evaluateFixedPaymentSchedule,
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

  it('allows month-end grace to continue into the next month', () => {
    const policy = {
      debtRuleType: 'MONTHLY_SCHEDULE' as const,
      hasCreditLimit: false,
      hasTermDays: false,
      paymentScheduleType: 'MONTHLY' as const,
      paymentScheduleDays: [30],
    };

    expect(
      computeCustomerAging(1000, [], policy, new Date('2026-10-05T12:00:00')),
    ).toMatchObject({ overdueAmount: 0, dueAmount: 1000 });
    expect(
      computeCustomerAging(1000, [], policy, new Date('2026-10-06T12:00:00')),
    ).toMatchObject({ overdueAmount: 1000, debtStatus: 'OVERDUE' });
  });

  it('keeps the previous month-end slot active during grace', () => {
    const result = evaluateFixedPaymentSchedule(
      [],
      'MONTHLY',
      [30],
      new Date('2026-10-02T12:00:00'),
    );

    expect(result).toMatchObject({
      required: 1,
      remaining: 1,
      overdueCount: 0,
      nextScheduledDate: new Date('2026-10-30T00:00:00'),
    });
  });

  it('supports multiple weekly payment days', () => {
    const result = resolveFixedSchedule(
      { paymentScheduleType: 'WEEKLY', paymentScheduleDays: [1, 4] },
      new Date('2026-09-09T12:00:00'),
    );

    expect(result.dueDate).toEqual(new Date('2026-09-07T00:00:00'));
  });

  it('counts only fixed monthly slots inside their five-day grace windows', () => {
    const result = evaluateFixedPaymentSchedule(
      [new Date('2026-09-16T12:00:00')],
      'MONTHLY',
      [15, 30],
      new Date('2026-09-20T12:00:00'),
    );

    expect(result).toMatchObject({
      paymentsThisMonth: 1,
      required: 1,
      remaining: 0,
      overdueCount: 0,
      periodType: 'MONTH',
    });

    const beforeFirstSlot = evaluateFixedPaymentSchedule(
      [],
      'MONTHLY',
      [15, 30],
      new Date('2026-09-10T12:00:00'),
    );
    expect(beforeFirstSlot).toMatchObject({
      paymentsThisPeriod: 0,
      required: 0,
      remaining: 0,
      met: true,
    });
  });

  it('evaluates weekly commitments against the current week, not the month', () => {
    const result = evaluateFixedPaymentSchedule(
      [new Date('2026-09-07T12:00:00')],
      'WEEKLY',
      [1, 4],
      new Date('2026-09-09T12:00:00'),
    );

    expect(result).toMatchObject({
      paymentsThisMonth: 1,
      required: 1,
      remaining: 0,
      periodType: 'WEEK',
    });
  });
});
