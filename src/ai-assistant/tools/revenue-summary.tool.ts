import { dateRange, rangeParameters, type AiTool } from './common';
import {
  branchOf,
  currentBranchParameter,
  money,
  vnEndIso,
  vnStartIso,
} from './tool-helpers';

/** Số mốc tối đa của xu hướng doanh thu. */
const MAX_TREND_POINTS = 62;

const PROFIT_PERMISSION = 'reports:sale_profit';

export const revenueSummaryTool: AiTool = {
  name: 'revenue_summary',
  label: 'Đang tổng hợp doanh thu',
  description: (scope) => {
    const profit = scope.can(PROFIT_PERMISSION);
    return `Doanh thu bán hàng (Tổng quan) trong khoảng ngày, tính trên hoá đơn trừ Đã hủy và Trả hàng: doanh thu, số hoá đơn, giá trị trung bình mỗi hoá đơn, so với kỳ liền trước cùng độ dài, hoá đơn còn phải thu, COD đang luân chuyển${
      profit
        ? ', lợi nhuận gộp và biên lợi nhuận (tạm tính theo giá vốn hiện tại)'
        : ''
    }. Tuỳ chọn: xu hướng theo giờ/ngày/tháng hoặc so sánh các chi nhánh.`;
  },
  parameters: {
    type: 'object',
    properties: {
      ...rangeParameters,
      breakdown: {
        type: 'string',
        enum: ['none', 'trend', 'branch'],
        description:
          'none = chỉ số tổng (mặc định), trend = doanh thu theo từng giờ/ngày/tháng, branch = so sánh tổng theo chi nhánh.',
      },
      currentBranchOnly: currentBranchParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('dashboard:view'),
  async run({ scope, now, deps }, args) {
    const range = dateRange(args, now);
    if ('error' in range) return range;
    const canProfit = scope.can(PROFIT_PERMISSION);
    const branchId = branchOf(scope, args);
    const custom = {
      from: new Date(vnStartIso(range.from)),
      to: new Date(vnEndIso(range.to)),
    };

    const stats = await deps.dashboard.getStatsOverview(
      'custom',
      branchId,
      custom,
    );
    const result: Record<string, unknown> = {
      from: range.from,
      to: range.to,
      branch: branchId ? 'Chi nhánh đang chọn' : 'Mọi chi nhánh',
      revenue: money(stats.currentRevenue),
      previousPeriodRevenue: money(stats.lastRevenue),
      revenueChangePct: stats.revenueChange,
      invoiceCount: stats.invoiceCount,
      invoiceChangePct: stats.invoiceChange,
      averageInvoiceValue: money(stats.aov),
      averageInvoiceChangePct: stats.aovChange,
      unpaidInvoices: stats.unpaidInvoices,
      unpaidAmount: money(stats.unpaidAmount),
      codInTransitAmount: money(stats.codAmount),
      codInTransitCount: stats.codCount,
      ...(canProfit
        ? {
            grossProfit: money(stats.profit),
            grossProfitChangePct: stats.profitChange,
            marginPct: Math.round(stats.marginAvg * 10000) / 100,
            profitNote: 'Lợi nhuận tạm tính theo giá vốn hiện tại.',
          }
        : {}),
    };

    if (args.breakdown === 'trend') {
      const points = await deps.dashboard.getRevenueTrend(
        'custom',
        branchId,
        custom,
      );
      result.trend = points.slice(0, MAX_TREND_POINTS).map((point) => ({
        label: point.label,
        revenue: money(point.revenue),
        ...(canProfit ? { grossProfit: money(point.profit) } : {}),
      }));
      result.trendMorePoints = points.length > MAX_TREND_POINTS;
    } else if (args.breakdown === 'branch') {
      const [revenue, profit] = await Promise.all([
        deps.dashboard.getBranchComparison('custom', 'rev', custom),
        canProfit
          ? deps.dashboard.getBranchComparison('custom', 'profit', custom)
          : Promise.resolve(null),
      ]);
      const profitOf = new Map(
        (profit?.branches ?? []).map((branch) => [branch.id, branch.total]),
      );
      result.branches = revenue.branches
        .map((branch) => ({
          branch: branch.name,
          revenue: money(branch.total),
          ...(canProfit
            ? { grossProfit: money(profitOf.get(branch.id) ?? 0) }
            : {}),
        }))
        .sort((a, b) => b.revenue - a.revenue);
    }

    return result;
  },
};
