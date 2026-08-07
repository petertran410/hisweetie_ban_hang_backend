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
import { FactoryProductsService } from './factory-products.service';
import {
  CreateFactoryProductDto,
  FactoryProductQueryDto,
  ReferencePricesQueryDto,
  UpdateFactoryProductDto,
} from './dto';

/**
 * Mapping (nhà máy × sản phẩm) + giá tham chiếu.
 * Dùng chung permission `factories:*` để không phải seed quyền mới
 * (seed permissions bị cấm chạy tự động theo AGENTS.md).
 */
@ApiTags('Factory Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('factory-products')
export class FactoryProductsController {
  constructor(private factoryProductsService: FactoryProductsService) {}

  @Get()
  @RequirePermissions('factories:view')
  findAll(@Query() query: FactoryProductQueryDto) {
    return this.factoryProductsService.findAll(query);
  }

  /**
   * Giá tham chiếu theo productIds — form đặt hàng nhập gọi endpoint này để
   * hiển thị chênh lệch so với đơn giá thực tế.
   */
  @Get('reference-prices')
  @RequirePermissions('factories:view')
  getReferencePrices(@Query() query: ReferencePricesQueryDto) {
    return this.factoryProductsService.getReferencePrices(query);
  }

  @Get(':id/price-history')
  @RequirePermissions('factories:view')
  getPriceHistory(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.getPriceHistory(id);
  }

  @Get(':id')
  @RequirePermissions('factories:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.findOne(id);
  }

  @Post()
  @RequirePermissions('factories:update')
  create(@Body() dto: CreateFactoryProductDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.factoryProductsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('factories:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFactoryProductDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.factoryProductsService.update(id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('factories:update')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.remove(id);
  }
}
