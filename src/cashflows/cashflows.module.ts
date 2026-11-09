import { Module } from '@nestjs/common';
import { CashFlowsController } from './cashflows.controller';
import { CashFlowsService } from './cashflows.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { CashFlowHistoryAuditService } from './cashflow-history-audit.service';
import { ManufacturersModule } from '../manufacturers/manufacturers.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule, ManufacturersModule],
  controllers: [CashFlowsController],
  providers: [CashFlowsService, CashFlowHistoryAuditService],
  exports: [CashFlowsService],
})
export class CashFlowsModule {}
