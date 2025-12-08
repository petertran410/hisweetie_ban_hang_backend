import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

class ReportQueryDto {
  @IsDate()
  @Type(() => Date)
  dateFrom: Date;

  @IsDate()
  @Type(() => Date)
  dateTo: Date;
}

@Controller('reports')
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Get('sales')
  getSalesReport(@Query() query: ReportQueryDto) {
    return this.reportsService.getSalesReport(query.dateFrom, query.dateTo);
  }

  @Get('customers')
  getCustomerReport(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerReport(query.dateFrom, query.dateTo);
  }

  @Get('products')
  getProductReport(@Query() query: ReportQueryDto) {
    return this.reportsService.getProductReport(query.dateFrom, query.dateTo);
  }

  @Get('inventory')
  getInventoryReport() {
    return this.reportsService.getInventoryReport();
  }

  @Get('dashboard')
  getDashboardStats() {
    return this.reportsService.getDashboardStats();
  }
}
