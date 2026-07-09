import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { OrdersService } from './orders.service';
import {
  CreateOrderDto,
  UpdateOrderDto,
  OrderQueryDto,
  ProductPriceHistoryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CancelOrderDto } from './dto/cancel-order.dto';

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

  @Get('product-price-history')
  @RequirePermissions('orders:view')
  getProductPriceHistory(@Query() params: ProductPriceHistoryDto) {
    return this.ordersService.getProductPriceHistory(
      +params.customerId,
      +params.productId,
      params.type,
      params.branchId ? +params.branchId : undefined,
    );
  }

  @Get('pending-summary')
  @RequirePermissions('orders:view')
  getPendingSummary(
    @Query('productIds') productIds?: string,
    @Query('branchId') branchId?: string,
  ) {
    const ids = (productIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
    return this.ordersService.getPendingSummary(
      ids,
      branchId ? +branchId : undefined,
    );
  }

  @Get('totals')
  @RequirePermissions('orders:view')
  getTotals(@Query() query: OrderQueryDto, @CurrentUser() user: any) {
    return this.ordersService.getTotals(query, user);
  }

  @Get('export')
  @RequirePermissions('orders:export')
  async export(
    @Query() query: OrderQueryDto,
    @CurrentUser() user: any,
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
      `attachment; filename=DatHang_${ts}.xlsx`,
    );

    await this.ordersService.exportOrders(query, res, user);
  }

  @Get('export-detail')
  @RequirePermissions('orders:export')
  async exportDetail(
    @Query() query: OrderQueryDto,
    @CurrentUser() user: any,
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
      `attachment; filename=DatHang_ChiTiet_${ts}.xlsx`,
    );

    await this.ordersService.exportOrdersDetail(query, res, user);
  }

  @Get('pending-by-product')
  @RequirePermissions('orders:view')
  getPendingByProduct(
    @Query('productId') productId: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.ordersService.getPendingByProduct(
      +productId,
      branchId ? +branchId : undefined,
    );
  }

  @Put(':id/cancel')
  @RequirePermissions('orders:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.ordersService.cancelOrder(+id, dto, user.id);
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
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.ordersService.remove(+id, user.id);
  }
}
