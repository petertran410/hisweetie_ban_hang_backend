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
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrderPaymentsService } from './purchase-order-payments.service';
import {
  CreatePurchaseOrderDto,
  CreatePurchaseOrderFromOrderSupplierDto,
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
  CancelPurchaseOrderDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';
import { getSupplierScope } from '../auth/supplier-scope.util';

@ApiTags('Purchase Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private purchaseOrdersService: PurchaseOrdersService,
    private purchaseOrderPaymentsService: PurchaseOrderPaymentsService,
  ) {}

  @Get()
  @RequirePermissions('purchase_orders:view')
  findAll(@Query() query: PurchaseOrderQueryDto, @Req() req: any) {
    return this.purchaseOrdersService.findAll(query, getSupplierScope(req));
  }

  @Get('export')
  @RequirePermissions('purchase_orders:export')
  async export(
    @Query() query: PurchaseOrderQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=NhapHang_${ts}.xlsx`,
    );

    await this.purchaseOrdersService.exportPurchaseOrders(
      query,
      res,
      getSupplierScope(req),
    );
  }

  @Get('export-detail')
  @RequirePermissions('purchase_orders:export')
  async exportDetail(
    @Query() query: PurchaseOrderQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=NhapHang_ChiTiet_${ts}.xlsx`,
    );

    await this.purchaseOrdersService.exportPurchaseOrdersDetail(
      query,
      res,
      getSupplierScope(req),
    );
  }

  @Get(':id')
  @RequirePermissions('purchase_orders:view')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.purchaseOrdersService.findOne(+id, getSupplierScope(req));
  }

  @Post()
  @RequirePermissions('purchase_orders:create')
  create(@Body() dto: CreatePurchaseOrderDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.create(dto, userId);
  }

  @Post('from-order-supplier/:orderSupplierId')
  @RequirePermissions('purchase_orders:create')
  @ApiOperation({
    summary:
      'Tạo phiếu nhập hàng từ phiếu đặt hàng nhập, kế thừa số tiền đã thanh toán ở PDN',
  })
  createFromOrderSupplier(
    @Param('orderSupplierId') orderSupplierId: string,
    @Body() dto: CreatePurchaseOrderFromOrderSupplierDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.createFromOrderSupplier(
      +orderSupplierId,
      dto,
      userId,
    );
  }

  @Put(':id')
  @RequirePermissions('purchase_orders:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.update(+id, dto, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('purchase_orders:update')
  @ApiOperation({
    summary:
      'Hủy mềm phiếu nhập hàng, hoàn nguyên kho + soft-cancel payment/cashflow',
  })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.cancelPurchaseOrder(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('purchase_orders:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.remove(+id, userId);
  }

  @Post(':id/payments')
  @RequirePermissions('purchase_orders:update')
  createPayment(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    dto.purchaseOrderId = +id;
    const userId = req.user?.id || 1;
    return this.purchaseOrderPaymentsService.create(dto, userId);
  }

  @Get(':id/payments')
  @RequirePermissions('purchase_orders:view')
  getPayments(@Param('id') id: string, @Req() req: any) {
    return this.purchaseOrderPaymentsService.findAllByPurchaseOrder(
      +id,
      getSupplierScope(req),
    );
  }

  @Delete('payments/:paymentId')
  @RequirePermissions('purchase_orders:delete')
  removePayment(@Param('paymentId') paymentId: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.purchaseOrderPaymentsService.remove(+paymentId, userId);
  }
}
