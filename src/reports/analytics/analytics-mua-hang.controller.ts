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
import { AnalyticsMuaHangService } from './analytics-mua-hang.service';
import {
  MuaHangCodeMergeDto,
  MuaHangCodeMergeUpdateDto,
  MuaHangConfigListQueryDto,
  MuaHangDemandQueryDto,
  MuaHangExcludedSellerDto,
  MuaHangFilterDto,
  MuaHangPurchaseProductDto,
  MuaHangPurchaseProductUpdateDto,
  MuaHangRebateDto,
  MuaHangRebateUpdateDto,
  MuaHangSalesQueryDto,
} from './analytics-mua-hang.dto';

// Phân tích › Chuyển Kho + Thu Mua. Quyền mặc định của cả controller: reports:analytics_purchasing
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@ReportPermission({ key: 'reports:analytics_purchasing' })
@Controller('reports/analytics/mua-hang')
export class AnalyticsMuaHangController {
  constructor(private readonly service: AnalyticsMuaHangService) {}

  @Get('filter-options')
  @ApiOperation({ summary: 'Chuyển Kho / Thu Mua: danh sách cho bộ lọc' })
  getFilterOptions() {
    return this.service.getFilterOptions();
  }

  @Get('chuyen-kho')
  @ApiOperation({
    summary:
      'Chuyển Kho › Chuyển Kho: tồn / đặt NCC / khách đặt / trên đường / bán 90 ngày theo kho',
  })
  getChuyenKho(@Query() q: MuaHangFilterDto) {
    return this.service.getChuyenKho(q);
  }

  @Get('chuyen-kho/hang-loai-b')
  @ApiOperation({
    summary:
      'Chuyển Kho › Hàng Loại B: cận date / bục rách / khuyến mãi theo kho',
  })
  getHangLoaiB(@Query() q: MuaHangFilterDto) {
    return this.service.getHangLoaiB(q);
  }

  @Get('thu-mua/ton-kho')
  @ApiOperation({ summary: 'Thu Mua › Tồn Kho' })
  getTonKho(@Query() q: MuaHangFilterDto) {
    return this.service.getTonKho(q);
  }

  @Get('thu-mua/nhom-hang')
  @ApiOperation({ summary: 'Thu Mua › Nhóm Hàng: số bán theo nhóm hàng lv2' })
  getNhomHang(@Query() q: MuaHangSalesQueryDto) {
    return this.service.getNhomHang(q);
  }

  @Get('thu-mua/nguon-hang')
  @ApiOperation({ summary: 'Thu Mua › Nguồn Hàng: số bán theo nguồn gốc' })
  getNguonHang(@Query() q: MuaHangSalesQueryDto) {
    return this.service.getNguonHang(q);
  }

  @Get('thu-mua/dat-theo-don')
  @ApiOperation({
    summary: 'Thu Mua › Đặt Theo Đơn: Demand đã xác nhận theo hàng × tháng',
  })
  getDatTheoDon(@Query() q: MuaHangDemandQueryDto) {
    return this.service.getDatTheoDon(q);
  }

  // ── Cấu hình ──────────────────────────────────────────────────────────────
  @Get('config/code-merges')
  @ReportPermission({ key: 'reports:analytics_config' })
  listCodeMerges(@Query() q: MuaHangConfigListQueryDto) {
    return this.service.listCodeMerges(q);
  }

  @Post('config/code-merges')
  @ReportPermission({ key: 'reports:analytics_config' })
  createCodeMerge(@Body() dto: MuaHangCodeMergeDto) {
    return this.service.createCodeMerge(dto);
  }

  @Patch('config/code-merges/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateCodeMerge(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MuaHangCodeMergeUpdateDto,
  ) {
    return this.service.updateCodeMerge(id, dto);
  }

  @Delete('config/code-merges/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteCodeMerge(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteCodeMerge(id);
  }

  @Get('config/excluded-sellers')
  @ReportPermission({ key: 'reports:analytics_config' })
  listExcludedSellers() {
    return this.service.listExcludedSellers();
  }

  @Post('config/excluded-sellers')
  @ReportPermission({ key: 'reports:analytics_config' })
  addExcludedSeller(@Body() dto: MuaHangExcludedSellerDto) {
    return this.service.addExcludedSeller(dto.userId);
  }

  @Delete('config/excluded-sellers/:userId')
  @ReportPermission({ key: 'reports:analytics_config' })
  removeExcludedSeller(@Param('userId', ParseIntPipe) userId: number) {
    return this.service.removeExcludedSeller(userId);
  }

  @Get('config/purchase-products')
  @ReportPermission({ key: 'reports:analytics_config' })
  listPurchaseProducts(@Query() q: MuaHangConfigListQueryDto) {
    return this.service.listPurchaseProducts(q);
  }

  @Post('config/purchase-products')
  @ReportPermission({ key: 'reports:analytics_config' })
  createPurchaseProduct(@Body() dto: MuaHangPurchaseProductDto) {
    return this.service.createPurchaseProduct(dto);
  }

  @Patch('config/purchase-products/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updatePurchaseProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MuaHangPurchaseProductUpdateDto,
  ) {
    return this.service.updatePurchaseProduct(id, dto);
  }

  @Delete('config/purchase-products/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deletePurchaseProduct(@Param('id', ParseIntPipe) id: number) {
    return this.service.deletePurchaseProduct(id);
  }

  @Get('config/rebates')
  @ReportPermission({ key: 'reports:analytics_config' })
  listRebates(@Query() q: MuaHangConfigListQueryDto) {
    return this.service.listRebates(q);
  }

  @Post('config/rebates')
  @ReportPermission({ key: 'reports:analytics_config' })
  createRebate(@Body() dto: MuaHangRebateDto) {
    return this.service.createRebate(dto);
  }

  @Patch('config/rebates/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateRebate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MuaHangRebateUpdateDto,
  ) {
    return this.service.updateRebate(id, dto);
  }

  @Delete('config/rebates/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteRebate(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteRebate(id);
  }
}
