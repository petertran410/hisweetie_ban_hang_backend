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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { FactoriesService } from './factories.service';
import {
  CreateFactoryDto,
  FactoryQueryDto,
  UpdateFactoryDto,
} from './dto';

@ApiTags('Factories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('factories')
export class FactoriesController {
  constructor(private factoriesService: FactoriesService) {}

  /**
   * List nhà máy với filter. Permission: factories:view (user tự thêm qua UI).
   * Backward compatible: giữ query `includeInactive` cho code cũ nếu có.
   */
  @Get()
  @RequirePermissions('factories:view')
  findAll(@Query() query: FactoryQueryDto) {
    return this.factoriesService.findAll(query);
  }

  /**
   * Lấy tất cả nhà máy (active) của 1 NCC — dùng cho dropdown trong các form
   * liên quan đến NCC (đặt hàng nhập, sản phẩm...).
   */
  @Get('by-supplier/:supplierId')
  @RequirePermissions('factories:view')
  getBySupplier(@Param('supplierId', ParseIntPipe) supplierId: number) {
    return this.factoriesService.getBySupplier(supplierId);
  }

  /**
   * Danh sách Product gắn nhà máy này (chia theo vai trò primary/backup) —
   * dùng cho trang read-only /san-pham/nha-may/[id]/san-pham.
   */
  @Get(':id/products')
  @RequirePermissions('factories:view')
  getProductsByFactory(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.getProductsByFactory(id);
  }

  @Get(':id')
  @RequirePermissions('factories:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.findOne(id);
  }

  @Post()
  @RequirePermissions('factories:create')
  create(@Body() dto: CreateFactoryDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.factoriesService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('factories:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFactoryDto,
  ) {
    return this.factoriesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('factories:delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.factoriesService.remove(id);
  }
}