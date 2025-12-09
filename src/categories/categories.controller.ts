import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get('roots')
  findRoots() {
    return this.categoriesService.findRoots();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(+id);
  }

  @Get(':id/children')
  findChildren(@Param('id') id: string) {
    return this.categoriesService.findChildren(+id);
  }

  @Post()
  create(
    @Body() data: { name: string; description?: string; parentId?: number },
  ) {
    return this.categoriesService.create(data);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      description?: string;
      parentId?: number;
      isActive?: boolean;
    },
  ) {
    return this.categoriesService.update(+id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(+id);
  }
}
