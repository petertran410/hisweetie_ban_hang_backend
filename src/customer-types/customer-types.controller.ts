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

@Controller('customer-types')
export class CustomerTypesController {
  constructor(private customerTypesService: CustomerTypesService) {}

  @Get()
  findAll() {
    return this.customerTypesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customerTypesService.findOne(+id);
  }

  @Post()
  create(@Body() data: { name: string; description?: string }) {
    return this.customerTypesService.create(data);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() data: any) {
    return this.customerTypesService.update(+id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customerTypesService.remove(+id);
  }
}
