import { Module } from '@nestjs/common';
import { PackingSlipsController } from './packing-slips.controller';
import { PackingSlipsService } from './packing-slips.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { N8nNotifyModule } from '../n8n-notify/n8n-notify.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, N8nNotifyModule, LarkSyncModule],
  controllers: [PackingSlipsController],
  providers: [PackingSlipsService],
  exports: [PackingSlipsService],
})
export class PackingSlipsModule {}
