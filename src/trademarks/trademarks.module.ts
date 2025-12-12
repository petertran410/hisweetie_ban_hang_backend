import { Module } from '@nestjs/common';
import { TrademarksController } from './trademarks.controller';
import { TrademarksService } from './trademarks.service';

@Module({
  controllers: [TrademarksController],
  providers: [TrademarksService],
  exports: [TrademarksService],
})
export class TrademarksModule {}
