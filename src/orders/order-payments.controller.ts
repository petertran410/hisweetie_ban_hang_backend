import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { OrderPaymentsService } from './order-payments.service';
import { CreateOrderPaymentDto } from './dto';

@Controller('order-payments')
export class OrderPaymentsController {
  constructor(private orderPaymentsService: OrderPaymentsService) {}

  @Post()
  create(@Body() dto: CreateOrderPaymentDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.orderPaymentsService.create(dto, userId);
  }

  @Get('order/:orderId')
  findAllByOrder(@Param('orderId') orderId: string) {
    return this.orderPaymentsService.findAllByOrder(+orderId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.orderPaymentsService.remove(+id);
  }
}
