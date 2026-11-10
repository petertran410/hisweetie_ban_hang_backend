import { incomeEfficiency } from './analytics-kpi-sale.service';

describe('incomeEfficiency', () => {
  it('chia doanh số cho KPI tháng của team, cùng mẫu số với Còn Lại', () => {
    const kpi = 4_000_000_000;
    const revenue = 3_999_461_200;

    expect(incomeEfficiency(kpi, revenue)).toBe(revenue / kpi);
    expect(kpi - revenue).toBe(538_800);
  });

  it('không dùng tổng KPI nhóm hàng', () => {
    const productKpi = 3_645_384_501;
    const revenue = 3_999_461_200;

    expect(incomeEfficiency(4_000_000_000, revenue)).not.toBe(
      revenue / productKpi,
    );
  });

  it('để trống khi chưa có KPI tháng', () => {
    expect(incomeEfficiency(null, 100)).toBeNull();
    expect(incomeEfficiency(0, 100)).toBeNull();
  });
});
