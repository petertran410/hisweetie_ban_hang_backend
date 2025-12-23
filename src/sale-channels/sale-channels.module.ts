import { Module } from '@nestjs/common';
import { SaleChannelsController } from './sale-channels.controller';
import { SaleChannelsService } from './sale-channels.service';

@Module({
  controllers: [SaleChannelsController],
  providers: [SaleChannelsService],
  exports: [SaleChannelsService],
})
export class SaleChannelsModule {}
