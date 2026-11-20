import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ManufacturersService } from './manufacturers.service';
import { PayablesService } from './payables.service';
import { ManufacturerDto, PayablePaymentDto } from './dto';
import { ManufacturerStockService } from './manufacturer-stock.service';
import { ManufacturerStockSlipDto } from './manufacturer-stock.dto';

@Controller('manufacturers')
@UseGuards(JwtAuthGuard)
export class ManufacturersController {
  constructor(
    private readonly service: ManufacturersService,
    private readonly payables: PayablesService,
    private readonly stock: ManufacturerStockService,
  ) {}

  private internal(req: any) {
    if (req.user?.supplierId) throw new ForbiddenException('Chỉ nhân viên nội bộ được thao tác nhà sản xuất');
  }

  @Get()
  @RequirePermissions('productions:view')
  list(@Query() query: any, @Req() req: any) {
    this.internal(req);
    const readBoolean = (key: 'isActive' | 'hasInProgress' | 'hasDebt') => {
      const value = query[key];
      if (value === undefined) return undefined;
      if (value !== 'true' && value !== 'false') {
        throw new BadRequestException(`Bộ lọc ${key} phải là true hoặc false`);
      }
      return value === 'true';
    };
    return this.service.list(
      query.search, query.includeInactive === 'true', query.pageSize, query.currentItem,
      readBoolean('isActive'),
      { hasInProgress: readBoolean('hasInProgress'), hasDebt: readBoolean('hasDebt') },
    );
  }

  @Post()
  @RequirePermissions('productions:create')
  create(@Body() dto: ManufacturerDto, @Req() req: any) { this.internal(req); return this.service.save(dto); }

  // ── Phiếu nguyên liệu tại NSX (route tĩnh khai báo trước ':id') ─────────

  @Get('stock-slips/by-code/:code')
  @RequirePermissions('productions:view')
  stockSlipByCode(@Param('code') code: string, @Req() req: any) { this.internal(req); return this.stock.findByCode(code); }

  @Get('stock-slips/:slipId')
  @RequirePermissions('productions:view')
  stockSlip(@Param('slipId', ParseIntPipe) slipId: number, @Req() req: any) { this.internal(req); return this.stock.findOne(slipId); }

  @Put('stock-slips/:slipId')
  @RequirePermissions('productions:update')
  updateStockSlip(@Param('slipId', ParseIntPipe) slipId: number, @Body() dto: ManufacturerStockSlipDto, @Req() req: any) {
    this.internal(req);
    return this.stock.update(slipId, dto, req.user.id);
  }

  @Post('stock-slips/:slipId/cancel')
  @RequirePermissions('productions:delete')
  cancelStockSlip(@Param('slipId', ParseIntPipe) slipId: number, @Req() req: any) {
    this.internal(req);
    return this.stock.cancel(slipId, req.user.id);
  }

  @Get(':id')
  @RequirePermissions('productions:view')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.service.get(id); }

  @Put(':id')
  @RequirePermissions('productions:update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: ManufacturerDto, @Req() req: any) { this.internal(req); return this.service.save(dto, id); }

  @Get(':id/accounts')
  @RequirePermissions('productions:view')
  accounts(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.payables.manufacturerAccounts(id); }

  @Get(':id/stock')
  @RequirePermissions('productions:view')
  stockList(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.stock.list(id); }

  @Get(':id/stock/moves')
  @RequirePermissions('productions:view')
  stockMoves(@Param('id', ParseIntPipe) id: number, @Query('productId', ParseIntPipe) productId: number, @Req() req: any) {
    this.internal(req);
    return this.stock.moves(id, productId);
  }

  @Get(':id/stock-slips')
  @RequirePermissions('productions:view')
  stockSlips(@Param('id', ParseIntPipe) id: number, @Query('type') type: string | undefined, @Req() req: any) {
    this.internal(req);
    return this.stock.slips(id, type);
  }

  @Post(':id/stock-slips')
  @RequirePermissions('productions:create')
  createStockSlip(@Param('id', ParseIntPipe) id: number, @Body() dto: ManufacturerStockSlipDto, @Req() req: any) {
    this.internal(req);
    return this.stock.create(id, dto, req.user.id);
  }

  @Get(':id/payables')
  @RequirePermissions('cash_flows:view')
  payablesList(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.payables.manufacturerSummary(id); }

  @Post(':id/payments')
  @RequirePermissions('cash_flows:create')
  pay(@Param('id', ParseIntPipe) id: number, @Body() dto: PayablePaymentDto, @Req() req: any) { this.internal(req); return this.payables.pay('M', id, dto, req.user.id); }
}

@Controller('payables')
@UseGuards(JwtAuthGuard)
export class PayablesController {
  constructor(private readonly service: PayablesService) {}

  @Get('suppliers/:id')
  @RequirePermissions('cash_flows:view')
  supplier(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    if (req.user?.supplierId && req.user.supplierId !== id) throw new ForbiddenException();
    return this.service.supplierSummary(id);
  }

  @Delete('payments/:id')
  @RequirePermissions('cash_flows:delete')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    if (req.user?.supplierId) throw new ForbiddenException();
    return this.service.cancelBatch(id, req.user.id);
  }
}
