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
} from '@nestjs/common';
import { OrderSuppliersService } from './order-suppliers.service';
import { OrderSupplierPaymentsService } from './order-supplier-payments.service';
import {
  CreateOrderSupplierDto,
  UpdateOrderSupplierDto,
  OrderSupplierQueryDto,
  CreateOrderSupplierPaymentDto,
  CancelOrderSupplierDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

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
  findAll(@Query() query: OrderSupplierQueryDto) {
    return this.orderSuppliersService.findAll(query);
  }

  @Get('confirmed-summary')
  @RequirePermissions('order_suppliers:view')
  getConfirmedSummary(
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
    );
  }

  @Get('confirmed-by-product')
  @RequirePermissions('order_suppliers:view')
  getConfirmedByProduct(
    @Query('productId') productId: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.orderSuppliersService.getConfirmedByProduct(
      +productId,
      branchId ? +branchId : undefined,
    );
  }

  @Get('detail-items')
  @RequirePermissions('order_suppliers:view')
  getDetailItems(@Query() query: OrderSupplierQueryDto) {
    return this.orderSuppliersService.getDetailItems(query);
  }

  @Get(':id')
  @RequirePermissions('order_suppliers:view')
  findOne(@Param('id') id: string) {
    return this.orderSuppliersService.findOne(+id);
  }

  @Post()
  @RequirePermissions('order_suppliers:create')
  create(@Body() dto: CreateOrderSupplierDto, @Req() req: any) {
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
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.cancelOrderSupplier(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('order_suppliers:delete')
  remove(@Param('id') id: string, @Req() req: any) {
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
    dto.orderSupplierId = +id;
    const userId = req.user?.id || 1;
    return this.orderSupplierPaymentsService.create(dto, userId);
  }

  @Get(':id/payments')
  @RequirePermissions('order_suppliers:view')
  getPayments(@Param('id') id: string) {
    return this.orderSupplierPaymentsService.findAllByOrderSupplier(+id);
  }

  @Delete('payments/:paymentId')
  @RequirePermissions('order_suppliers:delete')
  removePayment(@Param('paymentId') paymentId: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.orderSupplierPaymentsService.remove(+paymentId, userId);
  }
}
