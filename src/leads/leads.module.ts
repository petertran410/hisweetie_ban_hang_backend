import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SmaxModule } from '../smax/smax.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { LeadLinkModule } from './lead-link/lead-link.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsCron } from './leads.cron';
import {
  LeadFormsController,
  PublicLeadFormsController,
} from './lead-forms.controller';
import { LeadFormsService } from './lead-forms.service';
import { LeadReportsController } from './lead-reports/lead-reports.controller';
import { LeadReportsService } from './lead-reports/lead-reports.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    SmaxModule,
    LarkSyncModule,
    LeadLinkModule,
  ],
  controllers: [
    LeadsController,
    LeadFormsController,
    PublicLeadFormsController,
    LeadReportsController,
  ],
  providers: [LeadsService, LeadsCron, LeadFormsService, LeadReportsService],
})
export class LeadsModule {}
