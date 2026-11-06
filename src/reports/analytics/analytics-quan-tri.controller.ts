import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import { AnalyticsQuanTriService } from './analytics-quan-tri.service';
import {
  QtExclusionDto,
  QtExclusionUpdateDto,
  QtProfitQueryDto,
  QtQueryDto,
} from './analytics-quan-tri.dto';

// Phân tích › Quản Trị. Quyền mặc định của cả controller: reports:analytics_management
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@ReportPermission({ key: 'reports:analytics_management' })
@Controller('reports/analytics/quan-tri')
export class AnalyticsQuanTriController {
  constructor(private readonly service: AnalyticsQuanTriService) {}

  @Get('filter-options')
  @ApiOperation({ summary: 'Quản Trị: danh sách cho bộ lọc' })
  filterOptions() {
    return this.service.getFilterOptions();
  }

  @Get('tong-quan')
  @ApiOperation({ summary: 'Quản Trị › Tổng Quan' })
  overview(@Query() q: QtQueryDto) {
    return this.service.getOverview(q);
  }

  @Get('loi-nhuan')
  @ApiOperation({ summary: 'Quản Trị › Lợi Nhuận (view = bookmark)' })
  profit(@Query() q: QtProfitQueryDto) {
    return this.service.getProfit(q);
  }

  @Get('khach-hang')
  @ApiOperation({ summary: 'Quản Trị › Khách Hàng' })
  customers(@Query() q: QtQueryDto) {
    return this.service.getCustomers(q);
  }

  @Get('san-pham')
  @ApiOperation({ summary: 'Quản Trị › Sản Phẩm' })
  products(@Query() q: QtQueryDto) {
    return this.service.getProducts(q);
  }

  // ── Cấu hình: khách / nhân viên không tính vào báo cáo ─────────────────
  @Get('config/exclusions')
  @ReportPermission({ key: 'reports:analytics_config' })
  listExclusions() {
    return this.service.listExclusions();
  }

  @Post('config/exclusions')
  @ReportPermission({ key: 'reports:analytics_config' })
  createExclusion(@Body() dto: QtExclusionDto) {
    return this.service.createExclusion(dto);
  }

  @Patch('config/exclusions/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateExclusion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: QtExclusionUpdateDto,
  ) {
    return this.service.updateExclusion(id, dto);
  }

  @Delete('config/exclusions/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteExclusion(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteExclusion(id);
  }
}
