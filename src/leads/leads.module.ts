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
  ],
  providers: [LeadsService, LeadsCron, LeadFormsService],
})
export class LeadsModule {}
