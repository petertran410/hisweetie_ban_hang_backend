import { DebtPolicyImportService } from './debt-policy-import.service';
import {
  DEBT_RULE_TYPE,
  PAYMENT_SCHEDULE_TYPE,
} from './debt-tracking.constants';

describe('DebtPolicyImportService parser', () => {
  const service = new DebtPolicyImportService({} as never);

  describe('parseDebtType', () => {
    it.each([
      ['Không Công Nợ', DEBT_RULE_TYPE.NONE],
      ['Hạn Mức', DEBT_RULE_TYPE.CREDIT_LIMIT],
      ['Công Nợ 7 Ngày', DEBT_RULE_TYPE.TERM_DAYS],
      ['Thanh Toán Cố Định Tháng', DEBT_RULE_TYPE.MONTHLY_SCHEDULE],
      ['Thanh Toán Cố Định Tuần', DEBT_RULE_TYPE.WEEKLY_SCHEDULE],
    ])('maps %s to %s', (raw, debtRuleType) => {
      expect(service.parseDebtType(raw)).toMatchObject({
        debtRuleType,
        recognized: true,
      });
    });

    it('rejects combined legacy rules', () => {
      expect(
        service.parseDebtType('Hạn Mức, Công Nợ 7 Ngày').recognized,
      ).toBe(false);
    });
  });

  describe('parsePaymentSchedule', () => {
    it('parses sorted unique monthly days', () => {
      expect(
        service.parsePaymentSchedule('15,30', PAYMENT_SCHEDULE_TYPE.MONTHLY),
      ).toEqual({ days: [15, 30], error: null });
    });

    it('parses Vietnamese weekdays to 1-7', () => {
      expect(
        service.parsePaymentSchedule(
          'Thứ 2, Thứ 5, Chủ nhật',
          PAYMENT_SCHEDULE_TYPE.WEEKLY,
        ),
      ).toEqual({ days: [1, 4, 7], error: null });
    });

    it.each([
      ['30,15', PAYMENT_SCHEDULE_TYPE.MONTHLY],
      ['15,15', PAYMENT_SCHEDULE_TYPE.MONTHLY],
      ['0', PAYMENT_SCHEDULE_TYPE.MONTHLY],
      ['32', PAYMENT_SCHEDULE_TYPE.MONTHLY],
      ['Thứ 8', PAYMENT_SCHEDULE_TYPE.WEEKLY],
      ['Thứ 5, Thứ 2', PAYMENT_SCHEDULE_TYPE.WEEKLY],
    ])('rejects invalid schedule %s', (raw, scheduleType) => {
      expect(
        service.parsePaymentSchedule(raw, scheduleType).error,
      ).toBeTruthy();
    });

    it('requires values for a fixed schedule', () => {
      expect(
        service.parsePaymentSchedule('', PAYMENT_SCHEDULE_TYPE.MONTHLY),
      ).toEqual({ days: null, error: 'Thiếu ngày thanh toán cho lịch cố định' });
    });
  });
});
