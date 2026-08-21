import { evaluateAutoPaymentHistory } from './payment-history.util';
import { PAYMENT_HISTORY } from './debt-tracking.constants';

describe('evaluateAutoPaymentHistory', () => {
  it('đúng hạn khi không có lần trễ', () => {
    const r = evaluateAutoPaymentHistory({
      lateCount: 0,
      maxDaysOverdue: 0,
      currentOverdueDays: 0,
      sampleSize: 5,
    });
    expect(r.history).toBe(PAYMENT_HISTORY.ON_TIME);
  });

  it('trễ nhẹ: tối đa 7 ngày và không quá 2 lần', () => {
    const r = evaluateAutoPaymentHistory({
      lateCount: 2,
      maxDaysOverdue: 7,
      currentOverdueDays: 0,
      sampleSize: 5,
    });
    expect(r.history).toBe(PAYMENT_HISTORY.SLIGHT_LATE);
  });

  it('thường xuyên chậm: quá 2 lần trễ', () => {
    const r = evaluateAutoPaymentHistory({
      lateCount: 3,
      maxDaysOverdue: 4,
      currentOverdueDays: 0,
      sampleSize: 6,
    });
    expect(r.history).toBe(PAYMENT_HISTORY.OFTEN_LATE);
  });

  it('thường xuyên chậm: có một khoản trễ 8–30 ngày', () => {
    const r = evaluateAutoPaymentHistory({
      lateCount: 1,
      maxDaysOverdue: 15,
      currentOverdueDays: 0,
      sampleSize: 4,
    });
    expect(r.history).toBe(PAYMENT_HISTORY.OFTEN_LATE);
  });

  it('rủi ro cao: quá hạn trên 30 ngày', () => {
    const r = evaluateAutoPaymentHistory({
      lateCount: 1,
      maxDaysOverdue: 31,
      currentOverdueDays: 31,
      sampleSize: 2,
    });
    expect(r.history).toBe(PAYMENT_HISTORY.HIGH_RISK);
  });
});
