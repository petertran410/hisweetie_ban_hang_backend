import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { CategoriesService, CategoryType } from './categories.service';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Get()
  @RequirePermissions('categories:view')
  findAll(@Query('type') type?: CategoryType) {
    if (type) {
      return this.categoriesService.findByType(type);
    }
    return this.categoriesService.findAll();
  }

  @Get(':id')
  @RequirePermissions('categories:view')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('categories:create')
  create(@Body() data: { name: string; type: CategoryType }) {
    return this.categoriesService.create(data);
  }

  @Put(':id')
  @RequirePermissions('categories:update')
  update(
    @Param('id') id: string,
    @Body() data: { name?: string; type?: CategoryType },
  ) {
    return this.categoriesService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermissions('categories:delete')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(+id);
  }
}
