import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SmaxModule } from '../smax/smax.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsCron } from './leads.cron';

@Module({
  imports: [PrismaModule, AuditLogsModule, SmaxModule, LarkSyncModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsCron],
})
export class LeadsModule {}
