import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service';
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

  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard statistics overview' })
  getStats() {
    return this.dashboardService.getStatsOverview();
  }

  @Get('revenue-chart')
  @ApiOperation({ summary: 'Get revenue chart data' })
  @ApiQuery({ name: 'months', required: false, type: Number })
  getRevenueChart(
    @Query('months', new ParseIntPipe({ optional: true })) months?: number,
  ) {
    return this.dashboardService.getRevenueChart(months || 6);
  }

  @Get('top-customers')
  @ApiOperation({ summary: 'Get top customers by revenue' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTopCustomers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getTopCustomers(limit || 10);
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

  // ======== THÊM MỚI: 3 endpoints ========

  @Get('today-stats')
  @ApiOperation({ summary: 'Get today sales stats' })
  getTodayStats() {
    return this.dashboardService.getTodayStats();
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Get top selling products this month' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTopProducts(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.dashboardService.getTopProducts(limit || 10);
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
