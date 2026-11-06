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
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import {
  KpiConfigListQueryDto,
  KpiIncomeRuleDto,
  KpiIncomeRuleUpdateDto,
  KpiProductMapDto,
  KpiProductMapUpdateDto,
  KpiProductTargetDto,
  KpiProductTargetUpdateDto,
  KpiRepRuleDto,
  KpiRepRuleUpdateDto,
  KpiRevenueTargetDto,
  KpiRevenueTargetUpdateDto,
  KpiSaleDailyQueryDto,
  KpiSaleOrderQueryDto,
  KpiSaleQueryDto,
} from './analytics-kpi-sale.dto';
import {
  AnalyticsKpiSaleService,
  KpiViewer,
} from './analytics-kpi-sale.service';

const CONFIG = { key: 'reports:analytics_config' };

// Phân tích › KPI Sale. Quyền mặc định của cả controller: reports:analytics_kpi
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
// Số liệu áp RLS theo người đăng nhập (xem AnalyticsKpiSaleService.scopeOf).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@ReportPermission({ key: 'reports:analytics_kpi' })
@Controller('reports/analytics/kpi-sale')
export class AnalyticsKpiSaleController {
  constructor(private readonly service: AnalyticsKpiSaleService) {}

  @Get('options')
  @ApiOperation({ summary: 'KPI Sale: danh sách cho bộ lọc' })
  options(@Request() req: { user?: KpiViewer }) {
    return this.service.getOptions(req.user);
  }

  @Get('sale-income')
  @ApiOperation({ summary: 'KPI Sale › Sale Income (và TPKD)' })
  saleIncome(
    @Query() q: KpiSaleQueryDto,
    @Request() req: { user?: KpiViewer },
  ) {
    return this.service.getSaleIncome(q, req.user);
  }

  @Get('theo-ngay')
  @ApiOperation({ summary: 'KPI Sale › Theo Ngày' })
  daily(
    @Query() q: KpiSaleDailyQueryDto,
    @Request() req: { user?: KpiViewer },
  ) {
    return this.service.getDaily(q, req.user);
  }

  @Get('len-don-ho')
  @ApiOperation({ summary: 'KPI Sale › Lên Đơn Hộ' })
  orderOnBehalf(
    @Query() q: KpiSaleOrderQueryDto,
    @Request() req: { user?: KpiViewer },
  ) {
    return this.service.getOrderOnBehalf(q, req.user);
  }

  @Get('logic')
  @ApiOperation({
    summary: 'KPI Sale › Logic (quy tắc + doanh số theo quy tắc)',
  })
  logic(@Query() q: KpiSaleQueryDto, @Request() req: { user?: KpiViewer }) {
    return this.service.getLogic(q, req.user);
  }

  // ═══ Cấu hình (reports:analytics_config) ═══════════════════════════════
  @Get('config/options')
  @ReportPermission(CONFIG)
  configOptions() {
    return this.service.getConfigOptions();
  }

  @Get('config/revenue-targets')
  @ReportPermission(CONFIG)
  listRevenueTargets(@Query() q: KpiConfigListQueryDto) {
    return this.service.listRevenueTargets(q.year);
  }

  @Post('config/revenue-targets')
  @ReportPermission(CONFIG)
  createRevenueTarget(@Body() dto: KpiRevenueTargetDto) {
    return this.service.createRevenueTarget(dto);
  }

  @Patch('config/revenue-targets/:id')
  @ReportPermission(CONFIG)
  updateRevenueTarget(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KpiRevenueTargetUpdateDto,
  ) {
    return this.service.updateRevenueTarget(id, dto);
  }

  @Delete('config/revenue-targets/:id')
  @ReportPermission(CONFIG)
  deleteRevenueTarget(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteConfig('revenue-targets', id);
  }

  @Get('config/product-targets')
  @ReportPermission(CONFIG)
  listProductTargets(@Query() q: KpiConfigListQueryDto) {
    return this.service.listProductTargets(q.year);
  }

  @Post('config/product-targets')
  @ReportPermission(CONFIG)
  createProductTarget(@Body() dto: KpiProductTargetDto) {
    return this.service.createProductTarget(dto);
  }

  @Patch('config/product-targets/:id')
  @ReportPermission(CONFIG)
  updateProductTarget(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KpiProductTargetUpdateDto,
  ) {
    return this.service.updateProductTarget(id, dto);
  }

  @Delete('config/product-targets/:id')
  @ReportPermission(CONFIG)
  deleteProductTarget(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteConfig('product-targets', id);
  }

  @Get('config/rep-rules')
  @ReportPermission(CONFIG)
  listRepRules() {
    return this.service.listRepRules();
  }

  @Post('config/rep-rules')
  @ReportPermission(CONFIG)
  createRepRule(@Body() dto: KpiRepRuleDto) {
    return this.service.createRepRule(dto);
  }

  @Patch('config/rep-rules/:id')
  @ReportPermission(CONFIG)
  updateRepRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KpiRepRuleUpdateDto,
  ) {
    return this.service.updateRepRule(id, dto);
  }

  @Delete('config/rep-rules/:id')
  @ReportPermission(CONFIG)
  deleteRepRule(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteConfig('rep-rules', id);
  }

  @Get('config/income-rules')
  @ReportPermission(CONFIG)
  listIncomeRules() {
    return this.service.listIncomeRules();
  }

  @Post('config/income-rules')
  @ReportPermission(CONFIG)
  createIncomeRule(@Body() dto: KpiIncomeRuleDto) {
    return this.service.createIncomeRule(dto);
  }

  @Patch('config/income-rules/:id')
  @ReportPermission(CONFIG)
  updateIncomeRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KpiIncomeRuleUpdateDto,
  ) {
    return this.service.updateIncomeRule(id, dto);
  }

  @Delete('config/income-rules/:id')
  @ReportPermission(CONFIG)
  deleteIncomeRule(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteConfig('income-rules', id);
  }

  @Get('config/product-maps')
  @ReportPermission(CONFIG)
  listProductMaps() {
    return this.service.listProductMaps();
  }

  @Post('config/product-maps')
  @ReportPermission(CONFIG)
  createProductMap(@Body() dto: KpiProductMapDto) {
    return this.service.createProductMap(dto);
  }

  @Patch('config/product-maps/:id')
  @ReportPermission(CONFIG)
  updateProductMap(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KpiProductMapUpdateDto,
  ) {
    return this.service.updateProductMap(id, dto);
  }

  @Delete('config/product-maps/:id')
  @ReportPermission(CONFIG)
  deleteProductMap(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteConfig('product-maps', id);
  }
}
