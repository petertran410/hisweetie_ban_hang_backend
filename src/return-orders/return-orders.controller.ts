import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ReturnOrdersService } from './return-orders.service';
import {
  CreateReturnOrderDto,
  ConfirmStockReceivedDto,
  ConfirmRefundDto,
  ReturnOrderQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Return Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('return-orders')
export class ReturnOrdersController {
  constructor(private returnOrdersService: ReturnOrdersService) {}

  @Get()
  @RequirePermissions('return_orders:view')
  findAll(@Query() query: ReturnOrderQueryDto) {
    return this.returnOrdersService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('return_orders:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.returnOrdersService.findOne(id);
  }

  @Post()
  @RequirePermissions('return_orders:create')
  create(@Body() dto: CreateReturnOrderDto, @CurrentUser() user: any) {
    return this.returnOrdersService.create(dto, user.id);
  }

  @Put(':id/confirm-stock')
  @RequirePermissions('return_orders:update')
  confirmStockReceived(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmStockReceivedDto,
    @CurrentUser() user: any,
  ) {
    return this.returnOrdersService.confirmStockReceived(id, dto, user.id);
  }

  @Put(':id/confirm-refund')
  @RequirePermissions('return_orders:update')
  confirmRefund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmRefundDto,
    @CurrentUser() user: any,
  ) {
    return this.returnOrdersService.confirmRefund(id, dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('return_orders:cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.returnOrdersService.cancel(id, user.id);
  }
}
