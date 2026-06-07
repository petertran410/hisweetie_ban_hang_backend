import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  Res,
} from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  CreateInvoiceFromOrderDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequirePermissions,
  RequireAnyPermission,
} from '../auth/decorators/permissions.decorator';
import { Response } from 'express';

@ApiTags('Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  @RequirePermissions('invoices:view')
  findAll(@Query() query: InvoiceQueryDto, @CurrentUser() user: any) {
    return this.invoicesService.findAll(query, user);
  }

  @Get('unpaid-by-partner')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Lấy hóa đơn chưa thanh toán đầy đủ theo đối tác' })
  getUnpaidByPartner(
    @Query('partnerId') partnerId: string,
    @Query('partnerType') partnerType: string,
  ) {
    return this.invoicesService.findUnpaidByPartner(+partnerId, partnerType);
  }

  @Get('for-return-order')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Lấy hóa đơn khả dụng để tạo phiếu trả hàng' })
  findForReturnOrder(
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.invoicesService.findForReturnOrder({
      search,
      branchId: branchId ? +branchId : undefined,
      limit: limit ? +limit : 20,
    });
  }

  @Get('for-packing')
  @RequireAnyPermission(
    'packing_slips:create',
    'packing_hangs:create',
    'packing_loadings:create',
    'invoices:view',
  )
  @ApiOperation({ summary: 'Lấy hóa đơn cho luồng báo đơn (minimal fields)' })
  findForPacking(
    @Query('branchId') branchId?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.invoicesService.findForPacking({
      branchId: branchId ? +branchId : undefined,
      pageSize: pageSize ? +pageSize : 100,
      search,
    });
  }

  @Get('delivery-overview')
  @RequireAnyPermission('packing_slips:view', 'invoices:view')
  @ApiOperation({
    summary:
      'Tổng quan giao hàng trong ngày (3 ô thống kê + danh sách đơn chưa giao)',
  })
  findDeliveryOverview(
    @CurrentUser() user: any,
    @Query('branchId') branchId?: string,
    @Query('date') date?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('search') search?: string,
    @Query('pageSize') pageSize?: string,
    @Query('currentItem') currentItem?: string,
  ) {
    return this.invoicesService.findDeliveryOverview({
      branchId: branchId ? +branchId : undefined,
      date,
      fromDate,
      toDate,
      search,
      pageSize: pageSize ? +pageSize : 20,
      currentItem: currentItem ? +currentItem : 0,
      currentUser: user,
    });
  }

  @Get('export-detail/columns')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Lấy catalog cột export chi tiết' })
  getDetailColumns() {
    return this.invoicesService.getDetailColumns();
  }

  @Get('totals')
  @RequirePermissions('invoices:view')
  @ApiOperation({
    summary: 'Tổng các cột tiền của TOÀN BỘ hóa đơn match filter',
  })
  getTotals(@Query() query: InvoiceQueryDto, @CurrentUser() user: any) {
    return this.invoicesService.getTotals(query, user);
  }

  @Get('vat')
  @RequirePermissions('vat_invoices:view')
  @ApiOperation({ summary: 'Danh sách hóa đơn VAT (dữ liệu Misa)' })
  findAllVat(@Query() query: InvoiceQueryDto, @CurrentUser() user: any) {
    return this.invoicesService.findAllVat(query, user);
  }

  @Get('vat/totals')
  @RequirePermissions('vat_invoices:view')
  @ApiOperation({
    summary: 'Tổng các cột VAT của TOÀN BỘ hóa đơn match filter',
  })
  getVatTotals(@Query() query: InvoiceQueryDto, @CurrentUser() user: any) {
    return this.invoicesService.getVatTotals(query, user);
  }

  @Get('export')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Xuất Excel hóa đơn tổng quan' })
  async exportOverview(@Query() query: InvoiceQueryDto, @Res() res: Response) {
    const ts = Date.now();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=HoaDon_TongQuan_${ts}.xlsx`,
    );
    await this.invoicesService.exportOverview(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('invoices:view')
  @ApiOperation({ summary: 'Xuất Excel hóa đơn chi tiết' })
  async exportDetail(
    @Query() query: InvoiceQueryDto,
    @Query('columns') columnsParam: string,
    @Res() res: Response,
  ) {
    const selectedColumns = columnsParam
      ? columnsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const ts = Date.now();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=HoaDon_ChiTiet_${ts}.xlsx`,
    );
    await this.invoicesService.exportDetail(query, selectedColumns, res);
  }

  @Get(':id')
  @RequirePermissions('invoices:view')
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(+id);
  }

  @Get(':id/payment-history')
  @RequirePermissions('invoices:view')
  async getPaymentHistory(@Param('id', ParseIntPipe) id: number) {
    return this.invoicesService.getPaymentHistory(id);
  }

  @Post()
  @RequirePermissions('invoices:create')
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: any) {
    return this.invoicesService.create(dto, user.id);
  }

  @Put(':id')
  @RequirePermissions('invoices:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceDto,
    @CurrentUser() user: any,
  ) {
    return this.invoicesService.update(+id, dto, user.id);
  }

  @Post('from-order/:orderId')
  @RequirePermissions('invoices:create')
  createFromOrder(
    @Param('orderId') orderId: string,
    @Body() dto: CreateInvoiceFromOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.invoicesService.createFromOrder(+orderId, dto, user.id);
  }

  @Delete(':id')
  @RequirePermissions('invoices:delete')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.invoicesService.remove(+id, user.id);
  }
}
