import { Module } from '@nestjs/common';
import { CashFlowsController } from './cashflows.controller';
import { CashFlowsService } from './cashflows.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [CashFlowsController],
  providers: [CashFlowsService],
  exports: [CashFlowsService],
})
export class CashFlowsModule {}
