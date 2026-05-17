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
} from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ImportSupplierBalanceAdjustmentsDto } from './dto/import-supplier-balance-adjustment.dto';

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
