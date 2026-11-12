import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import { AnalyticsKeToanService } from './analytics-ke-toan.service';
import {
  KeToanCashQueryDto,
  KeToanMappingQueryDto,
  KeToanTransferQueryDto,
} from './analytics-ke-toan.dto';
import { AnalyticsCacheInterceptor } from './analytics-cache';

// Phân tích › Kế Toán. Quyền mặc định của cả controller: reports:analytics_accounting
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@UseInterceptors(AnalyticsCacheInterceptor)
@ReportPermission({ key: 'reports:analytics_accounting' })
@Controller('reports/analytics/ke-toan')
export class AnalyticsKeToanController {
  constructor(private readonly service: AnalyticsKeToanService) {}

  @Get('mapping-misa')
  @ApiOperation({
    summary: 'Kế Toán › Mapping Misa (mã hàng ↔ mã Misa, tồn HN/SG)',
  })
  getMappingMisa(@Query() query: KeToanMappingQueryDto) {
    return this.service.getMappingMisa(query);
  }

  @Get('tien-mat-kho')
  @ApiOperation({
    summary: 'Kế Toán › Tiền Mặt - Kho (tiền mặt trên phiếu báo đơn theo kho)',
  })
  getTienMatKho(@Query() query: KeToanCashQueryDto) {
    return this.service.getTienMatKho(query);
  }

  @Get('doi-soat')
  @ApiOperation({
    summary: 'Kế Toán › Đối Soát (COD giao hàng vs tiền mặt trên hoá đơn)',
  })
  getDoiSoat(@Query() query: KeToanCashQueryDto) {
    return this.service.getDoiSoat(query);
  }

  @Get('chuyen-hang')
  @ApiOperation({
    summary: 'Kế Toán › Chuyển Hàng (đề xuất điều chuyển Hà Nội → Sài Gòn)',
  })
  getChuyenHang(@Query() query: KeToanTransferQueryDto) {
    return this.service.getChuyenHang(query);
  }
}
