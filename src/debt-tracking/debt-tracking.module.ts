import { Module } from '@nestjs/common';
import { DebtTrackingController } from './debt-tracking.controller';
import { DebtTrackingService } from './debt-tracking.service';
import { DebtPolicyImportService } from './debt-policy-import.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuthModule, AuditLogsModule],
  controllers: [DebtTrackingController],
  providers: [DebtTrackingService, DebtPolicyImportService],
  exports: [DebtTrackingService, DebtPolicyImportService],
})
export class DebtTrackingModule {}
