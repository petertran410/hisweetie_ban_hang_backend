import { Module } from '@nestjs/common';
import { StockConditionTransfersController } from './stock-condition-transfers.controller';
import { StockConditionTransfersService } from './stock-condition-transfers.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [AuditLogsModule],
  controllers: [StockConditionTransfersController],
  providers: [StockConditionTransfersService],
  exports: [StockConditionTransfersService],
})
export class StockConditionTransfersModule {}
