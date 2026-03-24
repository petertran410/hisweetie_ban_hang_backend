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
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderDto, OrderQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Get()
  @RequirePermissions('orders:view')
  findAll(@Query() query: OrderQueryDto, @CurrentUser() user: any) {
    return this.ordersService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermissions('orders:view')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(+id);
  }

  @Post()
  @RequirePermissions('orders:create')
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: any) {
    return this.ordersService.create(dto, user.id);
  }

  @Put(':id')
  @RequirePermissions('orders:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.ordersService.update(+id, dto, user);
  }

  @Delete(':id')
  @RequirePermissions('orders:delete')
  remove(@Param('id') id: string) {
    return this.ordersService.remove(+id);
  }
}
