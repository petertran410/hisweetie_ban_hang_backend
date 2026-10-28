import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { UnitsService } from './units.service';
import {
  CreateUnitDto,
  ReorderUnitsDto,
  UnitQueryDto,
  UpdateUnitDto,
} from './dto';

@ApiTags('Units')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('units')
export class UnitsController {
  constructor(private unitsService: UnitsService) {}

  // Xem danh sách: mọi user đã đăng nhập (ô chọn Đơn vị tính ở form sản phẩm).
  @Get()
  findAll(@Query() query: UnitQueryDto) {
    return this.unitsService.findAll(query.includeInactive === 'true');
  }

  // Thêm / sửa / ẩn / gộp / xóa / sắp xếp: quyền riêng units:manage.
  @Post()
  @RequirePermissions('units:manage')
  create(@Body() dto: CreateUnitDto) {
    return this.unitsService.create(dto);
  }

  @Put('reorder')
  @RequirePermissions('units:manage')
  reorder(@Body() dto: ReorderUnitsDto) {
    return this.unitsService.reorder(dto);
  }

  @Put(':id')
  @RequirePermissions('units:manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUnitDto) {
    return this.unitsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('units:manage')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.unitsService.remove(id);
  }
}
