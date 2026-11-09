import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { LeadLinkService } from './lead-link.service';

/** Gắn lead ↔ khách + hành trình; dùng chung cho module Lead và Smax (gắn ID Zalo cho khách). */
@Module({
  imports: [PrismaModule, AuditLogsModule],
  providers: [LeadLinkService],
  exports: [LeadLinkService],
})
export class LeadLinkModule {}
