import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional } from 'class-validator';

class AnalyticsQueryDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  months?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('revenue-chart')
  getRevenueChart(@Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getRevenueChart(query.months || 12);
  }

  @Get('top-customers')
  getTopCustomers(@Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getTopCustomers(query.limit || 10);
  }

  @Get('low-stock')
  getLowStockProducts() {
    return this.analyticsService.getLowStockProducts();
  }

  @Get('debt-summary')
  getDebtSummary() {
    return this.analyticsService.getDebtSummary();
  }

  @Get('recent-activities')
  getRecentActivities() {
    return this.analyticsService.getRecentActivities();
  }
}
