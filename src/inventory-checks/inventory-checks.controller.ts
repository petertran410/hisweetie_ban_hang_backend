import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Put,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { InventoryChecksService } from './inventory-checks.service';
import { CreateInventoryCheckDto, InventoryCheckQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Inventory Checks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventory-checks')
export class InventoryChecksController {
  constructor(private service: InventoryChecksService) {}

  @Get()
  @RequirePermissions('inventory_checks:view')
  findAll(@Query() query: InventoryCheckQueryDto) {
    return this.service.findAll(query);
  }

  @Get('export')
  @RequirePermissions('inventory_checks:export')
  async export(@Query() query: InventoryCheckQueryDto, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=KiemHangLoaiB_${ts}.xlsx`,
    );

    await this.service.exportInventoryChecks(query, res);
  }

  @Get('export-detail')
  @RequirePermissions('inventory_checks:export')
  async exportDetail(
    @Query() query: InventoryCheckQueryDto,
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
      `attachment; filename=KiemHangLoaiB_ChiTiet_${ts}.xlsx`,
    );

    await this.service.exportInventoryChecksDetail(query, res);
  }

  @Get(':id')
  @RequirePermissions('inventory_checks:view')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Post()
  @RequirePermissions('inventory_checks:create')
  create(@Body() dto: CreateInventoryCheckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('inventory_checks:update')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(+id, user?.id);
  }
}
