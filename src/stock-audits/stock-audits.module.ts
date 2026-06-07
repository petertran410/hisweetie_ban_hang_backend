import { Module } from '@nestjs/common';
import { StockAuditsController } from './stock-audits.controller';
import { StockAuditsService } from './stock-audits.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [AuditLogsModule],
  controllers: [StockAuditsController],
  providers: [StockAuditsService],
  exports: [StockAuditsService],
})
export class StockAuditsModule {}
