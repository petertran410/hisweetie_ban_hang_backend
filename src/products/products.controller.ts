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
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Get()
  @RequirePermissions('products.view')
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('products.view')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(+id);
  }

  @Post()
  @RequirePermissions('products.create')
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Put(':id')
  @RequirePermissions('products.update')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('products.delete')
  remove(@Param('id') id: string) {
    return this.productsService.remove(+id);
  }

  @Get('low-stock')
  @RequirePermissions('products.view')
  checkLowStock() {
    return this.productsService.checkLowStock();
  }
}
