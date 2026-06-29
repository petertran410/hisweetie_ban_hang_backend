import { Module } from '@nestjs/common';
import { DestructionsController } from './destructions.controller';
import { DestructionsService } from './destructions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule],
  controllers: [DestructionsController],
  providers: [DestructionsService],
  exports: [DestructionsService],
})
export class DestructionsModule {}
