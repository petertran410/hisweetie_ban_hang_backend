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
  UpdatePurchaseOrderDto,
  PurchaseOrderQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

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
  @ApiOperation({ summary: 'Lấy danh sách nhập hàng' })
  findAll(@Query() query: PurchaseOrderQueryDto) {
    return this.purchaseOrdersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết nhập hàng theo ID' })
  findOne(@Param('id') id: string) {
    return this.purchaseOrdersService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới nhập hàng' })
  create(@Body() dto: CreatePurchaseOrderDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.purchaseOrdersService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật nhập hàng' })
  update(@Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.purchaseOrdersService.update(+id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa nhập hàng' })
  remove(@Param('id') id: string) {
    return this.purchaseOrdersService.remove(+id);
  }

  // Payment endpoints
  @Post(':id/payments')
  @ApiOperation({ summary: 'Tạo thanh toán cho nhập hàng' })
  createPayment(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    dto.purchaseOrderId = +id;
    const userId = req.user?.id || 1;
    return this.purchaseOrderPaymentsService.create(dto, userId);
  }

  @Get(':id/payments')
  @ApiOperation({ summary: 'Lấy danh sách thanh toán của nhập hàng' })
  getPayments(@Param('id') id: string) {
    return this.purchaseOrderPaymentsService.findAllByPurchaseOrder(+id);
  }

  @Delete('payments/:paymentId')
  @ApiOperation({ summary: 'Xóa thanh toán' })
  removePayment(@Param('paymentId') paymentId: string) {
    return this.purchaseOrderPaymentsService.remove(+paymentId);
  }
}
