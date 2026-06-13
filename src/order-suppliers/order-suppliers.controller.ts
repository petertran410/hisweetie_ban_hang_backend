import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { OrderSuppliersService } from './order-suppliers.service';
import { OrderSupplierPaymentsService } from './order-supplier-payments.service';
import {
  CreateOrderSupplierDto,
  UpdateOrderSupplierDto,
  OrderSupplierQueryDto,
  CreateOrderSupplierPaymentDto,
  CancelOrderSupplierDto,
  UpdateOrderSupplierItemFactoryPriceDto,
  UpdateOrderSupplierItemStageFactoryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';
import { getSupplierScope } from '../auth/supplier-scope.util';

/** Chặn tài khoản nhân viên nhà cung cấp thao tác ghi (tạo/sửa/xóa phiếu). */
function assertNotSupplierStaff(req: any) {
  if (getSupplierScope(req) != null) {
    throw new ForbiddenException(
      'Tài khoản nhà cung cấp không có quyền thao tác này',
    );
  }
}

@ApiTags('Order Suppliers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('order-suppliers')
export class OrderSuppliersController {
  constructor(
    private orderSuppliersService: OrderSuppliersService,
    private orderSupplierPaymentsService: OrderSupplierPaymentsService,
  ) {}

  @Get()
  @RequirePermissions('order_suppliers:view')
  findAll(@Query() query: OrderSupplierQueryDto, @Req() req: any) {
    return this.orderSuppliersService.findAll(query, getSupplierScope(req));
  }

  @Get('confirmed-summary')
  @RequirePermissions('order_suppliers:view')
  getConfirmedSummary(
    @Req() req: any,
    @Query('productIds') productIds?: string,
    @Query('branchId') branchId?: string,
  ) {
    const ids = (productIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
    return this.orderSuppliersService.getConfirmedSummary(
      ids,
      branchId ? +branchId : undefined,
      getSupplierScope(req),
    );
  }

  @Get('confirmed-by-product')
  @RequirePermissions('order_suppliers:view')
  getConfirmedByProduct(
    @Req() req: any,
    @Query('productId') productId: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.orderSuppliersService.getConfirmedByProduct(
      +productId,
      branchId ? +branchId : undefined,
      getSupplierScope(req),
    );
  }

  @Get('detail-items')
  @RequirePermissions('order_suppliers:view')
  getDetailItems(@Query() query: OrderSupplierQueryDto, @Req() req: any) {
    return this.orderSuppliersService.getDetailItems(
      query,
      getSupplierScope(req),
    );
  }

  @Patch('items/:orderSupplierId/:productId/factory-price')
  @RequirePermissions('order_suppliers:update')
  @ApiOperation({
    summary:
      'Cập nhật inline giá nhà máy / thành tiền nhà máy của 1 dòng sản phẩm trong PĐN',
  })
  updateItemFactoryPrice(
    @Param('orderSupplierId') orderSupplierId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateOrderSupplierItemFactoryPriceDto,
    @Req() req: any,
  ) {
    return this.orderSuppliersService.updateItemFactoryPrice(
      +orderSupplierId,
      +productId,
      dto,
      getSupplierScope(req),
    );
  }

  @Patch('items/:orderSupplierId/:productId/stage-factory')
  @RequirePermissions('order_suppliers:update')
  @ApiOperation({
    summary:
      'Cập nhật inline giai đoạn hiện tại / nhà máy của 1 dòng sản phẩm trong PĐN',
  })
  updateItemStageFactory(
    @Param('orderSupplierId') orderSupplierId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateOrderSupplierItemStageFactoryDto,
    @Req() req: any,
  ) {
    return this.orderSuppliersService.updateItemStageFactory(
      +orderSupplierId,
      +productId,
      dto,
      getSupplierScope(req),
    );
  }

  @Get(':id')
  @RequirePermissions('order_suppliers:view')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.orderSuppliersService.findOne(+id, getSupplierScope(req));
  }

  @Post()
  @RequirePermissions('order_suppliers:create')
  create(@Body() dto: CreateOrderSupplierDto, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('order_suppliers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderSupplierDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.update(+id, dto, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('order_suppliers:update')
  @ApiOperation({
    summary:
      'Hủy mềm phiếu đặt hàng nhập, đối xứng PUT /api/orders/:id/cancel của phía bán',
  })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderSupplierDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.cancelOrderSupplier(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('order_suppliers:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.remove(+id, userId);
  }

  @Put(':id/complete')
  @RequirePermissions('order_suppliers:update')
  @ApiOperation({
    summary:
      'Chốt hoàn thành PDN thủ công khi NCC không giao nốt phần còn thiếu',
  })
  complete(@Param('id') id: string, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.completeOrderSupplier(+id, userId);
  }

  @Post(':id/payments')
  @RequirePermissions('order_suppliers:update')
  createPayment(
    @Param('id') id: string,
    @Body() dto: CreateOrderSupplierPaymentDto,
    @Req() req: any,
  ) {
    assertNotSupplierStaff(req);
    dto.orderSupplierId = +id;
    const userId = req.user?.id || 1;
    return this.orderSupplierPaymentsService.create(dto, userId);
  }

  @Get(':id/payments')
  @RequirePermissions('order_suppliers:view')
  getPayments(@Param('id') id: string, @Req() req: any) {
    return this.orderSupplierPaymentsService.findAllByOrderSupplier(
      +id,
      getSupplierScope(req),
    );
  }

  @Delete('payments/:paymentId')
  @RequirePermissions('order_suppliers:delete')
  removePayment(@Param('paymentId') paymentId: string, @Req() req: any) {
    assertNotSupplierStaff(req);
    const userId = req.user?.id || 1;
    return this.orderSupplierPaymentsService.remove(+paymentId, userId);
  }
}
