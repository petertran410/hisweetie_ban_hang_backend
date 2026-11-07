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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import { AnalyticsKinhDoanhService } from './analytics-kinh-doanh.service';
import {
  KdChurnQueryDto,
  KdCustomerKeyDto,
  KdCustomerKeyUpdateDto,
  KdCustomerQueryDto,
  KdDlclColumnDto,
  KdDlclColumnUpdateDto,
  KdJamFlavorDto,
  KdJamFlavorUpdateDto,
  KdVisualTargetDto,
  KdVisualTargetUpdateDto,
  KdDashboardQueryDto,
  KdPivotQueryDto,
  KdQueryDto,
} from './analytics-kinh-doanh.dto';
import { AnalyticsCacheInterceptor } from './analytics-cache';

// Phân tích › Kinh Doanh (các trang ngoài Tổng Quan). Quyền mặc định của cả controller: reports:analytics_business
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@UseInterceptors(AnalyticsCacheInterceptor)
@ReportPermission({ key: 'reports:analytics_business' })
@Controller('reports/analytics/kinh-doanh')
export class AnalyticsKinhDoanhController {
  constructor(private readonly service: AnalyticsKinhDoanhService) {}

  /** Danh sách cho các bộ lọc riêng (loại hàng, thương hiệu, danh mục, sản phẩm, khách cha…). */
  @Get('options')
  options() {
    return this.service.getOptions();
  }

  /** BC Định Kì › Chi Tiết: pivot nhóm hàng × tuần, O1/O2/O3, hiệu quả nhân sự, nợ hiện tại. */
  @Get('bc-dinh-ki')
  periodicDetail(@Query() q: KdQueryDto) {
    return this.service.getPeriodicDetail(q);
  }

  /** BC Định Kì › Tuần Này / Tuần Trước / Tháng (html_weekly, html_last_week, html_monthly). */
  @Get('bc-dinh-ki/dashboard')
  periodicDashboard(@Query() q: KdDashboardQueryDto) {
    return this.service.getPeriodicDashboard(q, q.view);
  }

  /** BC Định Kì › Vùng (html_region). */
  @Get('bc-dinh-ki/vung')
  periodicRegion(@Query() q: KdQueryDto) {
    return this.service.getPeriodicRegion(q);
  }

  /** Pivot (matrix) chung, tải theo cấp: rows = các cấp dòng, path = giá trị các cấp trên. */
  @Get('pivot')
  pivot(@Query() q: KdPivotQueryDto) {
    return this.service.getPivot(q);
  }

  /** Khách Hàng: số liệu theo bookmark (overview, region, detail, repeat, demand, lermao…). */
  @Get('khach-hang')
  customer(@Query() q: KdCustomerQueryDto) {
    return this.service.getCustomerSection(q);
  }

  /** Khách Hàng › Churn Customer. */
  @Get('khach-hang/churn')
  customerChurn(@Query() q: KdChurnQueryDto) {
    return this.service.getCustomerChurn(q);
  }

  /** Sản Phẩm: xu hướng theo thương hiệu / ngành hàng, tăng trưởng MoM, Lermao + Phượng Hoàng. */
  @Get('san-pham')
  product(@Query() q: KdQueryDto) {
    return this.service.getProductPage(q);
  }

  /** Sản Phẩm › Báo Cáo Tồn Kho Chi Tiết. */
  @Get('san-pham/ton-kho')
  inventory(@Query() q: KdQueryDto) {
    return this.service.getInventory(q);
  }

  /** Đối Thủ: so sánh Lermao vs Boduo, hiệu quả nhân sự theo tháng / tuần, khách mới. */
  @Get('doi-thu')
  competitor(@Query() q: KdQueryDto) {
    return this.service.getCompetitorPage(q);
  }

  // ── Cấu hình (quyền reports:analytics_config) ─────────────────────────────
  @Get('config/visual-targets')
  @ReportPermission({ key: 'reports:analytics_config' })
  listVisualTargets(@Query('year') year?: string) {
    return this.service.listVisualTargets(
      year ? Number(year) || undefined : undefined,
    );
  }

  @Post('config/visual-targets')
  @ReportPermission({ key: 'reports:analytics_config' })
  upsertVisualTarget(@Body() dto: KdVisualTargetDto) {
    return this.service.upsertVisualTarget(dto);
  }

  @Patch('config/visual-targets/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateVisualTarget(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KdVisualTargetUpdateDto,
  ) {
    return this.service.updateVisualTarget(id, dto);
  }

  @Delete('config/visual-targets/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteVisualTarget(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteVisualTarget(id);
  }

  @Get('config/customer-keys')
  @ReportPermission({ key: 'reports:analytics_config' })
  listCustomerKeys() {
    return this.service.listCustomerKeys();
  }

  @Post('config/customer-keys')
  @ReportPermission({ key: 'reports:analytics_config' })
  createCustomerKey(@Body() dto: KdCustomerKeyDto) {
    return this.service.createCustomerKey(dto);
  }

  @Patch('config/customer-keys/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateCustomerKey(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KdCustomerKeyUpdateDto,
  ) {
    return this.service.updateCustomerKey(id, dto);
  }

  @Delete('config/customer-keys/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteCustomerKey(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteCustomerKey(id);
  }

  @Get('config/dlcl-columns')
  @ReportPermission({ key: 'reports:analytics_config' })
  listDlclColumns() {
    return this.service.listDlclColumns();
  }

  @Post('config/dlcl-columns')
  @ReportPermission({ key: 'reports:analytics_config' })
  createDlclColumn(@Body() dto: KdDlclColumnDto) {
    return this.service.createDlclColumn(dto);
  }

  @Patch('config/dlcl-columns/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateDlclColumn(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KdDlclColumnUpdateDto,
  ) {
    return this.service.updateDlclColumn(id, dto);
  }

  @Delete('config/dlcl-columns/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteDlclColumn(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteDlclColumn(id);
  }

  @Get('config/jam-flavors')
  @ReportPermission({ key: 'reports:analytics_config' })
  listJamFlavors() {
    return this.service.listJamFlavors();
  }

  @Post('config/jam-flavors')
  @ReportPermission({ key: 'reports:analytics_config' })
  createJamFlavor(@Body() dto: KdJamFlavorDto) {
    return this.service.createJamFlavor(dto);
  }

  @Patch('config/jam-flavors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateJamFlavor(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KdJamFlavorUpdateDto,
  ) {
    return this.service.updateJamFlavor(id, dto);
  }

  @Delete('config/jam-flavors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteJamFlavor(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteJamFlavor(id);
  }
}
