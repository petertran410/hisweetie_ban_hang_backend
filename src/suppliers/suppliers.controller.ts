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
  @ApiOperation({ summary: 'Cập nhật nhà cung cấp' })
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('suppliers:delete')
  @ApiOperation({ summary: 'Xóa nhà cung cấp' })
  remove(@Param('id') id: string) {
    return this.suppliersService.remove(+id);
  }
}
