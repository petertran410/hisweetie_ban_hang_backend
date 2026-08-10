import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Put,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { InventoryPromoChecksService } from './inventory-promo-checks.service';
import {
  CreateInventoryPromoCheckDto,
  InventoryPromoCheckQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Inventory Promo Checks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventory-promo-checks')
export class InventoryPromoChecksController {
  constructor(private service: InventoryPromoChecksService) {}

  @Get()
  @RequirePermissions('inventory_promo_checks:view')
  findAll(@Query() query: InventoryPromoCheckQueryDto) {
    return this.service.findAll(query);
  }

  @Get('export')
  @RequirePermissions('inventory_promo_checks:export')
  async export(
    @Query() query: InventoryPromoCheckQueryDto,
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
      `attachment; filename=KiemHangKhuyenMai_${ts}.xlsx`,
    );

    await this.service.exportInventoryPromoChecks(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('inventory_promo_checks:export')
  async exportDetail(
    @Query() query: InventoryPromoCheckQueryDto,
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
      `attachment; filename=KiemHangKhuyenMai_ChiTiet_${ts}.xlsx`,
    );

    await this.service.exportInventoryPromoChecksDetail(query, res);
  }

  @Get(':id')
  @RequirePermissions('inventory_promo_checks:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('inventory_promo_checks:create')
  create(@Body() dto: CreateInventoryPromoCheckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('inventory_promo_checks:update')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(+id, user?.id);
  }
}
