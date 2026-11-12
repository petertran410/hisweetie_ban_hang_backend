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
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import { AnalyticsKhachHangDlclService } from './analytics-khach-hang-dlcl.service';
import {
  AnalyticsDlclQueryDto,
  AnalyticsStrategicDistributorDto,
  AnalyticsStrategicDistributorListDto,
  AnalyticsStrategicDistributorUpdateDto,
  AnalyticsStrategicProgramUpdateDto,
} from './analytics-khach-hang-dlcl.dto';
import { AnalyticsCacheInterceptor } from './analytics-cache';

// Phân tích › Khách Hàng (trang ĐLCL, Biên Thương Mại, Chi Tiết, Xuất Data). Quyền mặc định của cả controller: reports:analytics_customer
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@UseInterceptors(AnalyticsCacheInterceptor)
@ReportPermission({ key: 'reports:analytics_customer' })
@Controller('reports/analytics/khach-hang-dlcl')
export class AnalyticsKhachHangDlclController {
  constructor(private readonly service: AnalyticsKhachHangDlclService) {}

  @Get('options')
  @ApiOperation({
    summary: 'Danh sách cho bộ lọc các trang ĐLCL / Chi Tiết / Xuất Data',
  })
  getOptions() {
    return this.service.getOptions();
  }

  @Get('dlcl-lermao')
  @ApiOperation({
    summary: 'ĐLCL Lermao: sản lượng Lermao theo đại lý chiến lược',
  })
  getLermao(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getLermao(q);
  }

  @Get('dlcl-mut-lermao')
  @ApiOperation({ summary: 'ĐLCL Mứt Lermao' })
  getMutLermao(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getMutLermao(q);
  }

  @Get('dlcl-boduo')
  @ApiOperation({ summary: 'ĐLCL Boduo' })
  getBoduo(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getBoduo(q);
  }

  @Get('dlcl-phuong-hoang')
  @ApiOperation({ summary: 'ĐLCL Phượng Hoàng' })
  getPhuongHoang(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getPhuongHoang(q);
  }

  @Get('bien-thuong-mai')
  @ApiOperation({ summary: 'Biên Thương Mại: giá buôn so với giá lẻ' })
  getBienThuongMai(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getBienThuongMai(q);
  }

  @Get('chi-tiet')
  @ApiOperation({
    summary: 'Chi Tiết: theo nhóm khách, xu hướng, khách × hàng × tháng/tuần',
  })
  getChiTiet(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getChiTiet(q);
  }

  @Get('xuat-data')
  @ApiOperation({
    summary: 'Xuất Data (> 12 tháng): khách cha × hàng × năm-tháng',
  })
  getXuatData(@Query() q: AnalyticsDlclQueryDto) {
    return this.service.getXuatData(q);
  }

  // ── Cấu hình ──────────────────────────────────────────────────────────────
  @Get('config/programs')
  @ReportPermission({ key: 'reports:analytics_config' })
  listPrograms() {
    return this.service.listPrograms();
  }

  @Patch('config/programs/:code')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateProgram(
    @Param('code') code: string,
    @Body() dto: AnalyticsStrategicProgramUpdateDto,
  ) {
    return this.service.updateProgram(code, dto);
  }

  @Get('config/distributors')
  @ReportPermission({ key: 'reports:analytics_config' })
  listDistributors(@Query() q: AnalyticsStrategicDistributorListDto) {
    return this.service.listDistributors(q.program);
  }

  @Post('config/distributors')
  @ReportPermission({ key: 'reports:analytics_config' })
  createDistributor(@Body() dto: AnalyticsStrategicDistributorDto) {
    return this.service.createDistributor(dto);
  }

  @Patch('config/distributors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateDistributor(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AnalyticsStrategicDistributorUpdateDto,
  ) {
    return this.service.updateDistributor(id, dto);
  }

  @Delete('config/distributors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteDistributor(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteDistributor(id);
  }
}
