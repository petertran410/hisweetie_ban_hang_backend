import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ManufacturersService } from './manufacturers.service';
import { PayablesService } from './payables.service';
import { ManufacturerDto, PayablePaymentDto } from './dto';

@Controller('manufacturers')
@UseGuards(JwtAuthGuard)
export class ManufacturersController {
  constructor(private readonly service: ManufacturersService, private readonly payables: PayablesService) {}

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

  @Get(':id')
  @RequirePermissions('productions:view')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.service.get(id); }

  @Put(':id')
  @RequirePermissions('productions:update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: ManufacturerDto, @Req() req: any) { this.internal(req); return this.service.save(dto, id); }

  @Get(':id/accounts')
  @RequirePermissions('productions:view')
  accounts(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.payables.manufacturerAccounts(id); }

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
