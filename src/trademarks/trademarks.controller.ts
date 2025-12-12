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

@Controller('trademarks')
export class TrademarksController {
  constructor(private trademarksService: TrademarksService) {}

  @Get()
  findAll() {
    return this.trademarksService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.trademarksService.findOne(+id);
  }

  @Post()
  create(@Body() data: { name: string; description?: string }) {
    return this.trademarksService.create(data);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() data: any) {
    return this.trademarksService.update(+id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.trademarksService.remove(+id);
  }
}
