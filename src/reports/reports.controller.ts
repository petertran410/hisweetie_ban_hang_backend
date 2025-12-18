// import { Controller, Get, Query } from '@nestjs/common';
// import { ReportsService } from './reports.service';

// @Controller('reports')
// export class ReportsController {
//   constructor(private reportsService: ReportsService) {}

//   @Get('sales')
//   getSalesReport(
//     @Query('dateFrom') dateFrom: string,
//     @Query('dateTo') dateTo: string,
//   ) {
//     return this.reportsService.getSalesReport(
//       new Date(dateFrom),
//       new Date(dateTo),
//     );
//   }

//   @Get('products')
//   getProductReport(
//     @Query('dateFrom') dateFrom?: string,
//     @Query('dateTo') dateTo?: string,
//   ) {
//     if (dateFrom && dateTo) {
//       return this.reportsService.getProductReport(
//         new Date(dateFrom),
//         new Date(dateTo),
//       );
//     }
//     return this.reportsService.getProductReport();
//   }

//   @Get('customers')
//   getCustomerReport(
//     @Query('dateFrom') dateFrom?: string,
//     @Query('dateTo') dateTo?: string,
//   ) {
//     if (dateFrom && dateTo) {
//       return this.reportsService.getCustomerReport(
//         new Date(dateFrom),
//         new Date(dateTo),
//       );
//     }
//     return this.reportsService.getCustomerReport();
//   }

//   @Get('inventory')
//   getInventoryReport() {
//     return this.reportsService.getInventoryReport();
//   }

//   @Get('financial')
//   getFinancialReport(
//     @Query('dateFrom') dateFrom: string,
//     @Query('dateTo') dateTo: string,
//   ) {
//     return this.reportsService.getFinancialReport(
//       new Date(dateFrom),
//       new Date(dateTo),
//     );
//   }

//   @Get('dashboard')
//   getDashboardStats() {
//     return this.reportsService.getDashboardStats();
//   }
// }
