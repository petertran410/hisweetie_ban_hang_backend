import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { StockAuditsService } from './stock-audits.service';
import {
  CreateStockAuditDto,
  UpdateStockAuditDto,
  StockAuditQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Stock Audits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-audits')
export class StockAuditsController {
  constructor(private service: StockAuditsService) {}

  @Get()
  @RequirePermissions('stock_audits:view')
  findAll(@Query() query: StockAuditQueryDto) {
    return this.service.findAll(query);
  }

  @Get('export')
  @RequirePermissions('stock_audits:export')
  async export(@Query() query: StockAuditQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=KiemKho_${ts}.xlsx`,
    );

    await this.service.exportStockAudits(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('stock_audits:export')
  async exportDetail(@Query() query: StockAuditQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=KiemKho_ChiTiet_${ts}.xlsx`,
    );

    await this.service.exportStockAuditsDetail(query, res);
  }

  @Get(':id')
  @RequirePermissions('stock_audits:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('stock_audits:create')
  create(@Body() dto: CreateStockAuditDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  // Preview tồn tại thời điểm (phục vụ UI form khi đổi checkDate / lùi ngày)
  @Post('preview-stock')
  @RequirePermissions('stock_audits:view')
  previewStock(
    @Body()
    body: {
      branchId: number;
      productIds: number[];
      checkDate: string;
    },
  ) {
    return this.service.previewStockAtDate(
      body.branchId,
      body.productIds || [],
      body.checkDate,
    );
  }

  @Put(':id')
  @RequirePermissions('stock_audits:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStockAuditDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(+id, dto, user?.id);
  }

  @Put(':id/complete')
  @RequirePermissions('stock_audits:update')
  complete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.complete(+id, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('stock_audits:update')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(+id, user?.id);
  }
}
