import { Module } from '@nestjs/common';
import { StockAuditsController } from './stock-audits.controller';
import { StockAuditsService } from './stock-audits.service';

@Module({
  controllers: [StockAuditsController],
  providers: [StockAuditsService],
  exports: [StockAuditsService],
})
export class StockAuditsModule {}
