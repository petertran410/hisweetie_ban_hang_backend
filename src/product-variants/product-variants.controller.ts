import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ProductVariantsService } from './product-variants.service';

@Controller('product-variants')
export class ProductVariantsController {
  constructor(private productVariantsService: ProductVariantsService) {}

  @Get()
  findAll() {
    return this.productVariantsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productVariantsService.findOne(+id);
  }

  @Post()
  create(@Body() data: { name: string; code: string; description?: string }) {
    return this.productVariantsService.create(data);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() data: any) {
    return this.productVariantsService.update(+id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productVariantsService.remove(+id);
  }
}
