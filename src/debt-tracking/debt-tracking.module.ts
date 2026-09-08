import { Module } from '@nestjs/common';
import { DebtTrackingController } from './debt-tracking.controller';
import { DebtTrackingService } from './debt-tracking.service';
import { DebtTrackingCycleService } from './debt-tracking-cycle.service';
import { DebtPolicyImportService } from './debt-policy-import.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuthModule, AuditLogsModule, LarkSyncModule],
  controllers: [DebtTrackingController],
  providers: [DebtTrackingService, DebtTrackingCycleService, DebtPolicyImportService],
  exports: [DebtTrackingService, DebtTrackingCycleService, DebtPolicyImportService],
})
export class DebtTrackingModule {}
