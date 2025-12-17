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
import { PriceBooksService } from './price-books.service';
import {
  CreatePriceBookDto,
  UpdatePriceBookDto,
  PriceBookQueryDto,
  ApplicablePriceBooksDto,
  ProductPriceDto,
  ProductsWithPricesQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Price Books')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('price-books')
export class PriceBooksController {
  constructor(private priceBooksService: PriceBooksService) {}

  @Get()
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get all price books' })
  findAll(@Query() query: PriceBookQueryDto) {
    return this.priceBooksService.findAll(query);
  }

  @Get('applicable')
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get applicable price books for context' })
  getApplicablePriceBooks(@Query() params: ApplicablePriceBooksDto) {
    return this.priceBooksService.getApplicablePriceBooks(params);
  }

  @Get('product-price')
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get price for a product from price books' })
  getPriceForProduct(@Query() params: ProductPriceDto) {
    return this.priceBooksService.getPriceForProduct(params);
  }

  @Get(':id')
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get price book by ID' })
  findOne(@Param('id') id: string) {
    return this.priceBooksService.findOne(+id);
  }

  @Get(':id/products')
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get products in price book' })
  getProductsByPriceBook(
    @Param('id') id: string,
    @Query('search') search?: string,
  ) {
    return this.priceBooksService.getProductsByPriceBook(+id, search);
  }

  @Post()
  @RequirePermissions('price_books.create')
  @ApiOperation({ summary: 'Create new price book' })
  async create(@Body() dto: CreatePriceBookDto) {
    const result = await this.priceBooksService.create(dto);
    return result;
  }

  @Post(':id/products')
  @RequirePermissions('price_books.update')
  @ApiOperation({ summary: 'Add products to price book' })
  addProducts(
    @Param('id') id: string,
    @Body() body: { products: { productId: number; price: number }[] },
  ) {
    return this.priceBooksService.addProductsToPriceBook(+id, body.products);
  }

  @Put(':id')
  @RequirePermissions('price_books.update')
  @ApiOperation({ summary: 'Update price book' })
  update(@Param('id') id: string, @Body() dto: UpdatePriceBookDto) {
    return this.priceBooksService.update(+id, dto);
  }

  @Put(':id/products/:productId')
  @RequirePermissions('price_books.update')
  @ApiOperation({ summary: 'Update product price in price book' })
  updateProductPrice(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() body: { price: number },
  ) {
    return this.priceBooksService.updateProductPrice(
      +id,
      +productId,
      body.price,
    );
  }

  @Delete(':id')
  @RequirePermissions('price_books.delete')
  @ApiOperation({ summary: 'Delete price book' })
  remove(@Param('id') id: string) {
    return this.priceBooksService.remove(+id);
  }

  @Delete(':id/products')
  @RequirePermissions('price_books.update')
  @ApiOperation({ summary: 'Remove products from price book' })
  removeProducts(
    @Param('id') id: string,
    @Body() body: { productIds: number[] },
  ) {
    return this.priceBooksService.removeProductsFromPriceBook(
      +id,
      body.productIds,
    );
  }

  @Get('products-with-prices')
  @RequirePermissions('price_books.view')
  @ApiOperation({ summary: 'Get all products with multiple price book prices' })
  getProductsWithPrices(@Query() query: ProductsWithPricesQueryDto) {
    return this.priceBooksService.getProductsWithMultiplePrices(
      query.priceBookIds,
      query.search,
      query.categoryId,
    );
  }
}
