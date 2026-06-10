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
  Req,
  Res,
} from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ImportSupplierBalanceAdjustmentsDto } from './dto/import-supplier-balance-adjustment.dto';
import { Response } from 'express';

@ApiTags('Suppliers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('suppliers')
export class SuppliersController {
  constructor(private suppliersService: SuppliersService) {}

  @Get()
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy danh sách nhà cung cấp' })
  findAll(@Query() query: SupplierQueryDto) {
    return this.suppliersService.findAll(query);
  }

  @Post('import-balance-adjustments')
  @RequirePermissions('suppliers:create')
  @ApiOperation({ summary: 'Import phiếu cân bằng nợ NCC từ Excel' })
  importBalanceAdjustments(@Body() dto: ImportSupplierBalanceAdjustmentsDto) {
    return this.suppliersService.importBalanceAdjustments(dto);
  }

  @Get(':id/debt-timeline')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy lịch sử công nợ nhà cung cấp' })
  getDebtTimeline(@Param('id') id: string) {
    return this.suppliersService.getDebtTimeline(+id);
  }

  @Get(':id/export-debt-timeline')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Xuất lịch sử giao dịch nhà cung cấp' })
  async exportDebtTimeline(@Param('id') id: string, @Res() res: Response) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=LichSuThanhToan_NCC${id}_${ts}.xlsx`,
    );

    await this.suppliersService.exportDebtTimeline(+id, res);
  }

  @Get(':id/export-debt')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Xuất công nợ chi tiết nhà cung cấp' })
  async exportSupplierDebt(
    @Param('id') id: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('branchId') branchId: string,
    @Query('includeDetails') includeDetails: string,
    @Query('showUnit') showUnit: string,
    @Query('showQty') showQty: string,
    @Query('showPrice') showPrice: string,
    @Query('showDiscount') showDiscount: string,
    @Query('showTotal') showTotal: string,
    @Query('showNote') showNote: string,
    @Res() res: Response,
  ) {
    const toBool = (v?: string) => v === 'true';

    await this.suppliersService.exportSupplierDebt(
      +id,
      {
        fromDate,
        toDate,
        branchId: branchId ? +branchId : undefined,
        includeDetails: toBool(includeDetails),
        showUnit: toBool(showUnit),
        showQty: toBool(showQty),
        showPrice: toBool(showPrice),
        showDiscount: toBool(showDiscount),
        showTotal: toBool(showTotal),
        showNote: toBool(showNote),
      },
      res,
    );
  }

  @Get(':id')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy chi tiết nhà cung cấp theo ID' })
  findOne(@Param('id') id: string) {
    return this.suppliersService.findOne(+id);
  }

  @Get('code/:code')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy chi tiết nhà cung cấp theo Code' })
  findByCode(@Param('code') code: string) {
    return this.suppliersService.findByCode(code);
  }

  @Post()
  @RequirePermissions('suppliers:create')
  @ApiOperation({ summary: 'Tạo mới nhà cung cấp' })
  create(@Body() dto: CreateSupplierDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    const branchId = dto.branchId || null;

    return this.suppliersService.create(dto, userId, branchId);
  }

  @Put(':id')
  @RequirePermissions('suppliers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.suppliersService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('suppliers:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.suppliersService.remove(+id, userId);
  }
}
