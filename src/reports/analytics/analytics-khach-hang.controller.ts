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
import { AnalyticsKhachHangService } from './analytics-khach-hang.service';
import {
  KhCustomerListItemDto,
  KhCustomerListQueryDto,
  KhSalePicDto,
  KhSalePicUpdateDto,
  KhSaleRepRuleDto,
  KhSaleRepRuleUpdateDto,
  KhachHangDemandQueryDto,
  KhachHangQueryDto,
  KhachHangWeeklyQueryDto,
} from './analytics-khach-hang.dto';
import { AnalyticsCacheInterceptor } from './analytics-cache';

const CONFIG = 'reports:analytics_config';

// Phân tích › Khách Hàng (trang Tất Cả, VIP, Key Persale, New, Repeat, Churn, Demand). Quyền mặc định của cả controller: reports:analytics_customer
// (endpoint cấu hình riêng thì gắn @ReportPermission({ key: 'reports:analytics_config' })).
@ApiTags('Reports - Phân tích')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@UseInterceptors(AnalyticsCacheInterceptor)
@ReportPermission({ key: 'reports:analytics_customer' })
@Controller('reports/analytics/khach-hang')
export class AnalyticsKhachHangController {
  constructor(private readonly service: AnalyticsKhachHangService) {}

  /** Danh sách cho các bộ lọc (slicer) của báo cáo Khách Hàng. */
  @Get('bo-loc')
  getFilterOptions() {
    return this.service.getFilterOptions();
  }

  /** Trang Tất Cả. */
  @Get('tong-quan')
  getOverview(@Query() query: KhachHangQueryDto) {
    return this.service.getOverview(query);
  }

  /** Trang VIP: khách thuộc nhóm có chữ "VIP" — % WoW + bảng theo tuần. */
  @Get('vip')
  getVip(@Query() query: KhachHangWeeklyQueryDto) {
    return this.service.getWeekly(query, 'vip');
  }

  /** Trang Key Persale: khách thuộc nhóm có chữ "KEY" hoặc "VIP". */
  @Get('key-persale')
  getKeyPersale(@Query() query: KhachHangWeeklyQueryDto) {
    return this.service.getWeekly(query, 'key');
  }

  /** Trang New Customer. */
  @Get('khach-moi')
  getNewCustomers(@Query() query: KhachHangQueryDto) {
    return this.service.getNewCustomers(query);
  }

  /** Trang Repeat Customer (cần chọn đúng 1 tháng). */
  @Get('khach-quay-lai')
  getRepeat(@Query() query: KhachHangQueryDto) {
    return this.service.getRepeat(query);
  }

  /** Trang Churn Customer. */
  @Get('khach-roi-bo')
  getChurn(@Query() query: KhachHangQueryDto) {
    return this.service.getChurn(query);
  }

  /** Trang Demand. */
  @Get('demand')
  getDemand(@Query() query: KhachHangDemandQueryDto) {
    return this.service.getDemand(query);
  }

  // ===== Cấu hình (quyền reports:analytics_config) =====

  @Get('config/customer-lists')
  @ReportPermission({ key: CONFIG })
  listCustomerList(@Query() query: KhCustomerListQueryDto) {
    return this.service.listCustomerList(query.listKey);
  }

  @Post('config/customer-lists')
  @ReportPermission({ key: CONFIG })
  addCustomerList(@Body() dto: KhCustomerListItemDto) {
    return this.service.addCustomerList(dto);
  }

  @Delete('config/customer-lists/:id')
  @ReportPermission({ key: CONFIG })
  deleteCustomerList(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteCustomerList(id);
  }

  @Get('config/sale-pics')
  @ReportPermission({ key: CONFIG })
  listSalePics() {
    return this.service.listSalePics();
  }

  @Post('config/sale-pics')
  @ReportPermission({ key: CONFIG })
  createSalePic(@Body() dto: KhSalePicDto) {
    return this.service.createSalePic(dto);
  }

  @Patch('config/sale-pics/:id')
  @ReportPermission({ key: CONFIG })
  updateSalePic(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KhSalePicUpdateDto,
  ) {
    return this.service.updateSalePic(id, dto);
  }

  @Delete('config/sale-pics/:id')
  @ReportPermission({ key: CONFIG })
  deleteSalePic(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteSalePic(id);
  }

  @Get('config/sale-rep-rules')
  @ReportPermission({ key: CONFIG })
  listSaleRepRules() {
    return this.service.listSaleRepRules();
  }

  @Post('config/sale-rep-rules')
  @ReportPermission({ key: CONFIG })
  createSaleRepRule(@Body() dto: KhSaleRepRuleDto) {
    return this.service.createSaleRepRule(dto);
  }

  @Patch('config/sale-rep-rules/:id')
  @ReportPermission({ key: CONFIG })
  updateSaleRepRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: KhSaleRepRuleUpdateDto,
  ) {
    return this.service.updateSaleRepRule(id, dto);
  }

  @Delete('config/sale-rep-rules/:id')
  @ReportPermission({ key: CONFIG })
  deleteSaleRepRule(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteSaleRepRule(id);
  }
}
