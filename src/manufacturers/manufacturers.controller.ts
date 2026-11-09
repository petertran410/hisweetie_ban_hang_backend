import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ManufacturersService } from './manufacturers.service';
import { PayablesService } from './payables.service';
import { ExternalTemplateDto, ManufacturerDto, PayablePaymentDto } from './dto';

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
    return this.service.list(query.search, query.includeInactive === 'true', query.pageSize, query.currentItem);
  }

  @Get('templates')
  @RequirePermissions('productions:view')
  templates(@Query('manufacturerId') manufacturerId: string, @Query('productId') productId: string, @Req() req: any) {
    this.internal(req);
    return this.service.templates(Number(manufacturerId) || undefined, Number(productId) || undefined);
  }

  @Post('templates')
  @RequirePermissions('productions:create')
  createTemplate(@Body() dto: ExternalTemplateDto, @Req() req: any) { this.internal(req); return this.service.saveTemplate(dto); }

  @Put('templates/:id')
  @RequirePermissions('productions:update')
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Body() dto: ExternalTemplateDto, @Req() req: any) { this.internal(req); return this.service.saveTemplate(dto, id); }

  @Delete('templates/:id')
  @RequirePermissions('productions:delete')
  removeTemplate(@Param('id', ParseIntPipe) id: number, @Req() req: any) { this.internal(req); return this.service.deactivateTemplate(id); }

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
