import { Module } from '@nestjs/common';
import { InternalUseController } from './internal-use.controller';
import { InternalUseService } from './internal-use.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule],
  controllers: [InternalUseController],
  providers: [InternalUseService],
  exports: [InternalUseService],
})
export class InternalUseModule {}
