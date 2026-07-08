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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ReturnOrdersService } from './return-orders.service';
import {
  CreateReturnOrderDto,
  ConfirmStockReceivedDto,
  ConfirmRefundDto,
  ReturnOrderQueryDto,
  UpdateStep1Dto,
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

  @Get('export')
  @RequirePermissions('return_orders:export')
  async export(@Query() query: ReturnOrderQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=TraHang_${ts}.xlsx`,
    );

    await this.returnOrdersService.exportReturnOrders(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('return_orders:export')
  async exportDetail(
    @Query() query: ReturnOrderQueryDto,
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
      `attachment; filename=TraHang_ChiTiet_${ts}.xlsx`,
    );

    await this.returnOrdersService.exportReturnOrdersDetail(query, res);
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

  @Put(':id/update-step1')
  @RequirePermissions('return_orders:update')
  updateStep1(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStep1Dto,
    @CurrentUser() user: any,
  ) {
    return this.returnOrdersService.updateStep1(id, dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('return_orders:cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.returnOrdersService.cancel(id, user.id, user.roles);
  }
}
