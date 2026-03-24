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
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

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
  @ApiOperation({ summary: 'Lấy danh sách đặt hàng nhập' })
  findAll(@Query() query: OrderSupplierQueryDto) {
    return this.orderSuppliersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết đặt hàng nhập theo ID' })
  findOne(@Param('id') id: string) {
    return this.orderSuppliersService.findOne(+id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mới đặt hàng nhập' })
  create(@Body() dto: CreateOrderSupplierDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.create(dto, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Cập nhật đặt hàng nhập' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderSupplierDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.update(+id, dto, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa đặt hàng nhập' })
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.orderSuppliersService.remove(+id, userId);
  }

  @Post(':id/payments')
  @ApiOperation({ summary: 'Tạo thanh toán cho đặt hàng nhập' })
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
  @ApiOperation({ summary: 'Lấy danh sách thanh toán của đặt hàng nhập' })
  getPayments(@Param('id') id: string) {
    return this.orderSupplierPaymentsService.findAllByOrderSupplier(+id);
  }

  @Delete('payments/:paymentId')
  @ApiOperation({ summary: 'Xóa thanh toán' })
  removePayment(@Param('paymentId') paymentId: string) {
    return this.orderSupplierPaymentsService.remove(+paymentId);
  }
}
