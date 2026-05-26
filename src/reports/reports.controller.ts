import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { ReportQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  // ── Báo cáo 1: Preview ──
  @Get('customer-sales')
  @ApiOperation({ summary: 'Preview báo cáo bán hàng theo hóa đơn' })
  getCustomerSalesPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerSalesPreview(query);
  }

  // ── Báo cáo 1: Export Excel ──
  @Get('customer-sales/export')
  @ApiOperation({ summary: 'Xuất Excel báo cáo bán hàng' })
  async exportCustomerSales(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `bao-cao-ban-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportCustomerSales(query, res);
  }

  // ── Báo cáo 2: Preview ──
  @Get('product-by-customer')
  @ApiOperation({ summary: 'Preview báo cáo hàng bán theo khách' })
  getProductByCustomerPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getProductByCustomerPreview(query);
  }

  // ── Báo cáo 2: Export Excel ──
  @Get('product-by-customer/export')
  @ApiOperation({ summary: 'Xuất Excel hàng bán theo khách' })
  async exportProductByCustomer(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `hang-ban-theo-khach_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportProductByCustomer(query, res);
  }

  // ── Báo cáo 3: Preview ──
  @Get('customer-debt')
  @ApiOperation({ summary: 'Preview báo cáo công nợ theo khách hàng' })
  getCustomerDebtPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerDebtPreview(query);
  }

  // ── Báo cáo 3: Export Excel ──
  @Get('customer-debt/export')
  @ApiOperation({ summary: 'Xuất Excel báo cáo công nợ theo khách hàng' })
  async exportCustomerDebt(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `bao-cao-cong-no-theo-khach-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportCustomerDebt(query, res);
  }
}
