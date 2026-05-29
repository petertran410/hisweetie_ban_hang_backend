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
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrderPaymentsService } from './purchase-order-payments.service';
import {
  CreatePurchaseOrderDto,
  CreatePurchaseOrderFromOrderSupplierDto,
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

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
  findAll(@Query() query: PurchaseOrderQueryDto) {
    return this.purchaseOrdersService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('purchase_orders:view')
  findOne(@Param('id') id: string) {
    return this.purchaseOrdersService.findOne(+id);
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
  getPayments(@Param('id') id: string) {
    return this.purchaseOrderPaymentsService.findAllByPurchaseOrder(+id);
  }

  @Delete('payments/:paymentId')
  @RequirePermissions('purchase_orders:delete')
  removePayment(@Param('paymentId') paymentId: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.purchaseOrderPaymentsService.remove(+paymentId, userId);
  }
}
