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
  @RequirePermissions('factories:create')
  create(@Body() dto: CreateFactoryProductDto, @Req() req: any) {
    return this.factoryProductsService.create(dto, req.user.id, req.user.name);
  }

  @Put(':id')
  @RequirePermissions('factories:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFactoryProductDto,
    @Req() req: any,
  ) {
    return this.factoryProductsService.update(
      id,
      dto,
      req.user.id,
      req.user.name,
    );
  }

  @Delete(':id')
  @RequirePermissions('factories:delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.factoryProductsService.remove(id);
  }
}
