import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import {
  DashboardService,
  RangeKey,
  PeriodKey,
  TopMetric,
  CategoryDimension,
  CustomRange,
} from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
// Dashboard tổng hợp toàn bộ dữ liệu nhạy cảm (doanh thu, công nợ, top khách...).
// Yêu cầu quyền dashboard:view. Super Admin auto-pass trong PermissionsGuard.
// Quyền này được seed gán sẵn cho Super Admin + Admin; có thể cấp thêm cho
// vai trò khác qua trang Cài đặt → Vai trò. Role không có quyền nhận 403.
@RequirePermissions('dashboard:view')
@Controller('dashboard')
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  /**
   * Khoảng ngày tùy chọn (from/to dạng ISO) — chỉ dùng khi range/period = 'custom'.
   * Thiếu from/to thì trả undefined (service tự rơi về mốc mặc định).
   */
  private parseCustom(
    key: string | undefined,
    from?: string,
    to?: string,
  ): CustomRange | undefined {
    if (key !== 'custom') return undefined;
    if (!from || !to) {
      throw new BadRequestException(
        'Thiếu from/to cho khoảng thời gian tùy chọn',
      );
    }
    const f = new Date(from);
    const t = new Date(to);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || f > t) {
      throw new BadRequestException('Khoảng thời gian tùy chọn không hợp lệ');
    }
    return { from: f, to: t };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard statistics overview' })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getStats(
    @Query('range') range?: RangeKey,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getStatsOverview(
      range || 'month',
      branchId,
      this.parseCustom(range, from, to),
    );
  }

  @Get('revenue-chart')
  @ApiOperation({ summary: 'Get revenue chart data (legacy monthly)' })
  @ApiQuery({ name: 'months', required: false, type: Number })
  getRevenueChart(
    @Query('months', new ParseIntPipe({ optional: true })) months?: number,
  ) {
    return this.dashboardService.getRevenueChart(months || 6);
  }

  @Get('revenue-trend')
  @ApiOperation({ summary: 'Revenue + profit trend by hour/day/week' })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getRevenueTrend(
    @Query('range') range?: RangeKey,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getRevenueTrend(
      range || 'today',
      branchId,
      this.parseCustom(range, from, to),
    );
  }

  @Get('category-breakdown')
  @ApiOperation({ summary: 'Revenue breakdown by product group' })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({ name: 'dimension', required: false })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getCategoryBreakdown(
    @Query('range') range?: RangeKey,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('dimension') dimension?: CategoryDimension,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getCategoryBreakdown(
      range || 'month',
      branchId,
      dimension || 'parent',
      this.parseCustom(range, from, to),
    );
  }

  @Get('category-options')
  @ApiOperation({ summary: 'Distinct product group values for filters' })
  @ApiQuery({ name: 'dimension', required: false })
  getCategoryOptions(@Query('dimension') dimension?: CategoryDimension) {
    return this.dashboardService.getCategoryOptions(dimension || 'parent');
  }

  @Get('branch-comparison')
  @ApiOperation({ summary: 'Compare active branches over time' })
  @ApiQuery({ name: 'period', required: false })
  @ApiQuery({ name: 'metric', required: false })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getBranchComparison(
    @Query('period') period?: PeriodKey,
    @Query('metric') metric?: 'rev' | 'profit',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getBranchComparison(
      period || 'd7',
      metric || 'rev',
      this.parseCustom(period, from, to),
    );
  }

  @Get('finance')
  @ApiOperation({ summary: 'Debt, COD and aging buckets' })
  @ApiQuery({ name: 'period', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getFinance(
    @Query('period') period?: PeriodKey | 'all',
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getFinance(
      period || 'all',
      branchId,
      this.parseCustom(period, from, to),
    );
  }

  @Get('tasks')
  @ApiOperation({ summary: 'Actionable task lists (orders/debt/cod/stock)' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false })
  getTasks(
    @Query('type') type?: 'orders' | 'debt' | 'cod' | 'stock',
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('status') status?: string,
  ) {
    return this.dashboardService.getTasks(
      type || 'orders',
      branchId,
      limit || 20,
      status,
    );
  }

  @Get('task-counts')
  @ApiOperation({ summary: 'Total counts per worklist tab (badge)' })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  getTaskCounts(
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
  ) {
    return this.dashboardService.getTaskCounts(branchId);
  }

  @Get('top-customers')
  @ApiOperation({ summary: 'Get top customers by revenue' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTopCustomers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getTopCustomers(limit || 10);
  }

  @Get('top-buyers')
  @ApiOperation({ summary: 'Top customers by invoice revenue in a time range' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range = custom',
  })
  getTopBuyers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('range') range?: RangeKey,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getTopBuyers(
      Math.min(limit || 10, 50),
      range || 'month',
      branchId,
      this.parseCustom(range, from, to),
    );
  }

  @Get('low-stock')
  @ApiOperation({ summary: 'Get low stock products' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getLowStock(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getLowStockProducts(limit || 20);
  }

  @Get('recent-orders')
  @ApiOperation({ summary: 'Get recent orders' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentOrders(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getRecentOrders(limit || 10);
  }

  @Get('today-stats')
  @ApiOperation({ summary: 'Get today sales stats' })
  getTodayStats() {
    return this.dashboardService.getTodayStats();
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Get top selling products' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @ApiQuery({ name: 'metric', required: false })
  @ApiQuery({ name: 'dimension', required: false })
  @ApiQuery({ name: 'categoryValue', required: false })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO — khi range/period = custom',
  })
  getTopProducts(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('range') range?: RangeKey,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
    @Query('metric') metric?: TopMetric,
    @Query('dimension') dimension?: CategoryDimension,
    @Query('categoryValue') categoryValue?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getTopProducts(
      limit || 10,
      range || 'month',
      branchId,
      metric || 'rev',
      dimension,
      categoryValue,
      this.parseCustom(range, from, to),
    );
  }

  @Get('recent-activities')
  @ApiOperation({ summary: 'Get recent order activities' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentActivities(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getRecentActivities(limit || 15);
  }
}
