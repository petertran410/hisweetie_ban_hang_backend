import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ReportPermission } from '../../auth/decorators/report-permission.decorator';
import { ReportsPermissionGuard } from '../reports-permission.guard';
import { AnalyticsBusinessQueryDto } from '../dto';
import { AnalyticsDinhKiService } from './analytics-dinh-ki.service';
import {
  DinhKiBrandQueryDto,
  DinhKiDateQueryDto,
  DinhKiDetailQueryDto,
  DkGroupTargetDto,
  DkGroupTargetListQueryDto,
  DkGroupTargetUpdateDto,
  DkJamFlavorDto,
  DkJamFlavorListQueryDto,
  DkJamFlavorUpdateDto,
  DkWeeklySellerDto,
  HangTuanQueryDto,
} from './analytics-dinh-ki.dto';

// Phân tích › Định Kì + Hằng Tuần. Quyền mặc định của cả controller: reports:analytics_periodic
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@ReportPermission({ key: 'reports:analytics_periodic' })
@Controller('reports/analytics/dinh-ki')
export class AnalyticsDinhKiController {
  constructor(private readonly service: AnalyticsDinhKiService) {}

  // ── Định Kì ─────────────────────────────────────────────────────────────
  /** Danh sách cho bộ lọc trang Tổng Quan (không cần quyền Kinh Doanh). */
  @Get('filter-options')
  filterOptions() {
    return this.service.getFilterOptions();
  }

  /** Tổng Quan — giống Kinh Doanh › Tổng Quan. */
  @Get('tong-quan')
  overview(@Query() q: AnalyticsBusinessQueryDto) {
    return this.service.getOverview(q);
  }

  /** Đối Thủ — so sánh Mứt Lermao vs Mứt Boduo. */
  @Get('doi-thu')
  brandCompare(@Query() q: DinhKiBrandQueryDto) {
    return this.service.getBrandCompare(q);
  }

  @Get('tuan-nay')
  thisWeek(@Query() q: DinhKiDateQueryDto) {
    return this.service.getWeekly(q, 'this');
  }

  @Get('tuan-truoc')
  lastWeek(@Query() q: DinhKiDateQueryDto) {
    return this.service.getWeekly(q, 'last');
  }

  @Get('thang')
  monthly(@Query() q: DinhKiDateQueryDto) {
    return this.service.getMonthly(q);
  }

  @Get('vung')
  region(@Query() q: DinhKiDateQueryDto) {
    return this.service.getRegion(q);
  }

  @Get('chi-tiet')
  detail(@Query() q: DinhKiDetailQueryDto) {
    return this.service.getDetail(q);
  }

  // ── Hằng Tuần ───────────────────────────────────────────────────────────
  @Get('hang-tuan')
  hangTuan(@Query() q: HangTuanQueryDto) {
    return this.service.getHangTuan(q);
  }

  // ── Cấu hình ────────────────────────────────────────────────────────────
  @Get('config/group-targets')
  @ReportPermission({ key: 'reports:analytics_config' })
  listGroupTargets(@Query() q: DkGroupTargetListQueryDto) {
    return this.service.listGroupTargets(q);
  }

  /** Thêm hoặc ghi đè chỉ tiêu (kind, nhóm, năm, tháng). */
  @Post('config/group-targets')
  @ReportPermission({ key: 'reports:analytics_config' })
  upsertGroupTarget(@Body() dto: DkGroupTargetDto) {
    return this.service.upsertGroupTarget(dto);
  }

  @Patch('config/group-targets/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateGroupTarget(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DkGroupTargetUpdateDto,
  ) {
    return this.service.updateGroupTarget(id, dto);
  }

  @Delete('config/group-targets/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteGroupTarget(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteGroupTarget(id);
  }

  @Get('config/jam-flavors')
  @ReportPermission({ key: 'reports:analytics_config' })
  listJamFlavors(@Query() q: DkJamFlavorListQueryDto) {
    return this.service.listJamFlavors(q);
  }

  @Post('config/jam-flavors')
  @ReportPermission({ key: 'reports:analytics_config' })
  createJamFlavor(@Body() dto: DkJamFlavorDto) {
    return this.service.createJamFlavor(dto);
  }

  @Patch('config/jam-flavors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  updateJamFlavor(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DkJamFlavorUpdateDto,
  ) {
    return this.service.updateJamFlavor(id, dto);
  }

  @Delete('config/jam-flavors/:id')
  @ReportPermission({ key: 'reports:analytics_config' })
  deleteJamFlavor(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteJamFlavor(id);
  }

  @Get('config/weekly-sellers')
  @ReportPermission({ key: 'reports:analytics_config' })
  listWeeklySellers() {
    return this.service.listWeeklySellers();
  }

  @Put('config/weekly-sellers/:userId')
  @ReportPermission({ key: 'reports:analytics_config' })
  setWeeklySeller(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: DkWeeklySellerDto,
  ) {
    return this.service.setWeeklySeller(userId, dto);
  }

  @Delete('config/weekly-sellers/:userId')
  @ReportPermission({ key: 'reports:analytics_config' })
  removeWeeklySeller(@Param('userId', ParseIntPipe) userId: number) {
    return this.service.removeWeeklySeller(userId);
  }
}
