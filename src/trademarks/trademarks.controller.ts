import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { TrademarksService } from './trademarks.service';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@Controller('trademarks')
export class TrademarksController {
  constructor(private trademarksService: TrademarksService) {}

  @Get()
  @RequirePermissions('trademarks:view')
  findAll() {
    return this.trademarksService.findAll();
  }

  @Get(':id')
  @RequirePermissions('trademarks:view')
  findOne(@Param('id') id: string) {
    return this.trademarksService.findOne(+id);
  }

  @Post()
  @RequirePermissions('trademarks:create')
  create(@Body() data: { name: string }) {
    return this.trademarksService.create(data);
  }

  @Put(':id')
  @RequirePermissions('trademarks:update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.trademarksService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermissions('trademarks:delete')
  remove(@Param('id') id: string) {
    return this.trademarksService.remove(+id);
  }
}
