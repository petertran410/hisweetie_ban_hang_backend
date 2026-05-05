import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SupplierGroupsService } from './supplier-groups.service';
import {
  CreateSupplierGroupDto,
  UpdateSupplierGroupDto,
  ManageSuppliersDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Supplier Groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('supplier-groups')
export class SupplierGroupsController {
  constructor(private supplierGroupsService: SupplierGroupsService) {}

  @Get()
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy danh sách nhóm nhà cung cấp' })
  findAll() {
    return this.supplierGroupsService.findAll();
  }

  @Get(':id')
  @RequirePermissions('suppliers:view')
  @ApiOperation({ summary: 'Lấy chi tiết nhóm nhà cung cấp' })
  findOne(@Param('id') id: string) {
    return this.supplierGroupsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('suppliers:create')
  @ApiOperation({ summary: 'Tạo mới nhóm nhà cung cấp' })
  create(@Body() dto: CreateSupplierGroupDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.supplierGroupsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('suppliers:update')
  @ApiOperation({ summary: 'Cập nhật nhóm nhà cung cấp' })
  update(@Param('id') id: string, @Body() dto: UpdateSupplierGroupDto) {
    return this.supplierGroupsService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('suppliers:delete')
  @ApiOperation({ summary: 'Xóa nhóm nhà cung cấp' })
  remove(@Param('id') id: string) {
    return this.supplierGroupsService.remove(+id);
  }

  @Post(':id/add-suppliers')
  @RequirePermissions('suppliers:update')
  @ApiOperation({ summary: 'Thêm nhà cung cấp vào nhóm' })
  addSuppliers(@Param('id') id: string, @Body() dto: ManageSuppliersDto) {
    return this.supplierGroupsService.addSuppliersToGroup(+id, dto.supplierIds);
  }

  @Post(':id/remove-suppliers')
  @RequirePermissions('suppliers:update')
  @ApiOperation({ summary: 'Xóa nhà cung cấp khỏi nhóm' })
  removeSuppliers(@Param('id') id: string, @Body() dto: ManageSuppliersDto) {
    return this.supplierGroupsService.removeSuppliersFromGroup(
      +id,
      dto.supplierIds,
    );
  }
}
