import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { CustomerTypesService } from './customer-types.service';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@Controller('customer-types')
export class CustomerTypesController {
  constructor(private customerTypesService: CustomerTypesService) {}

  @Get()
  @RequirePermissions('customers:view')
  findAll() {
    return this.customerTypesService.findAll();
  }

  @Get(':id')
  @RequirePermissions('customers:view')
  findOne(@Param('id') id: string) {
    return this.customerTypesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('customers:create')
  create(@Body() data: { name: string; description?: string }) {
    return this.customerTypesService.create(data);
  }

  @Put(':id')
  @RequirePermissions('customers:update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.customerTypesService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermissions('customers:delete')
  remove(@Param('id') id: string) {
    return this.customerTypesService.remove(+id);
  }
}
