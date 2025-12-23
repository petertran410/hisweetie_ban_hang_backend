import { Controller, Get } from '@nestjs/common';
import { SaleChannelsService } from './sale-channels.service';

@Controller('sale-channels')
export class SaleChannelsController {
  constructor(private saleChannelsService: SaleChannelsService) {}

  @Get()
  findAll() {
    return this.saleChannelsService.findAll();
  }
}
