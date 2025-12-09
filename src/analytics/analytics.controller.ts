import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('revenue-chart')
  getRevenueChart(@Query('months') months?: string) {
    return this.analyticsService.getRevenueChart(
      months ? parseInt(months) : 12,
    );
  }

  @Get('top-customers')
  getTopCustomers(@Query('limit') limit?: string) {
    return this.analyticsService.getTopCustomers(limit ? parseInt(limit) : 10);
  }

  @Get('low-stock')
  getLowStockProducts() {
    return this.analyticsService.getLowStockProducts();
  }

  @Get('debt-summary')
  getDebtSummary() {
    return this.analyticsService.getDebtSummary();
  }

  @Get('dashboard-stats')
  getDashboardStats() {
    return this.analyticsService.getDashboardStats();
  }

  @Get('recent-activities')
  getRecentActivities() {
    return this.analyticsService.getRecentActivities();
  }
}
