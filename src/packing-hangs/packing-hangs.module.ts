import { Module } from '@nestjs/common';
import { PackingHangsController } from './packing-hangs.controller';
import { PackingHangsService } from './packing-hangs.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule],
  controllers: [PackingHangsController],
  providers: [PackingHangsService],
  exports: [PackingHangsService],
})
export class PackingHangsModule {}
