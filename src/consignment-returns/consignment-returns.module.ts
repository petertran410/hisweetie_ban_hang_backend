import { Module } from '@nestjs/common';
import { ConsignmentReturnsController } from './consignment-returns.controller';
import { ConsignmentReturnsService } from './consignment-returns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsignmentsModule } from '../consignments/consignments.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, ConsignmentsModule, LarkSyncModule, AuditLogsModule],
  controllers: [ConsignmentReturnsController],
  providers: [ConsignmentReturnsService],
  exports: [ConsignmentReturnsService],
})
export class ConsignmentReturnsModule {}
