import { calculateOrderTiming } from './order-timing.engine';

const today = new Date('2026-08-20T00:00:00.000Z');

describe('calculateOrderTiming', () => {
  it('tính hạn đặt theo tồn gộp toàn công ty', () => {
    // Tồn gộp 120, bán 21/ngày → cạn sau ~5.7 ngày, trong khi chờ hàng mất 45.
    const result = calculateOrderTiming({
      today,
      leadTimeMaxDays: 40,
      safetyDays: 5,
      position: { onHand: 120, incoming: 0, dailyDemand: 21 },
    });

    expect(result.urgency).toBe('ORDER_NOW');
    expect(result.daysUntilOrderDeadline!).toBeLessThan(0);
  });

  it('khuyến nghị đặt tháng sau khi hạn đặt rơi vào tháng sau', () => {
    const result = calculateOrderTiming({
      today,
      leadTimeMaxDays: 20,
      safetyDays: 5,
      position: { onHand: 450, incoming: 0, dailyDemand: 10 },
    });

    // 45 ngày tồn - 25 ngày leadtime/đệm = còn 20 ngày, sang tháng 9.
    expect(result.urgency).toBe('ORDER_NEXT_MONTH');
    expect(result.daysUntilOrderDeadline).toBe(20);
  });

  it('cộng hàng đang đi đường trước khi xác định ngày thiếu', () => {
    const withoutIncoming = calculateOrderTiming({
      today,
      leadTimeMaxDays: 20,
      safetyDays: 5,
      position: { onHand: 100, incoming: 0, dailyDemand: 10 },
    });
    const withIncoming = calculateOrderTiming({
      today,
      leadTimeMaxDays: 20,
      safetyDays: 5,
      position: { onHand: 100, incoming: 300, dailyDemand: 10 },
    });

    expect(withIncoming.daysUntilOrderDeadline!).toBeGreaterThan(
      withoutIncoming.daysUntilOrderDeadline!,
    );
  });

  it('không đề xuất khi SKU chưa phát sinh bán', () => {
    const result = calculateOrderTiming({
      today,
      leadTimeMaxDays: 40,
      safetyDays: 5,
      position: { onHand: 0, incoming: 0, dailyDemand: 0 },
    });

    expect(result.urgency).toBe('NO_ACTION');
    expect(result.daysOfSupply).toBeNull();
  });

  it('không còn phân biệt chi nhánh nào thiếu trước', () => {
    const result = calculateOrderTiming({
      today,
      leadTimeMaxDays: 20,
      safetyDays: 5,
      position: { onHand: 450, incoming: 0, dailyDemand: 10 },
    });

    expect(result.recommendation).not.toMatch(/chi nhánh/i);
  });
});
