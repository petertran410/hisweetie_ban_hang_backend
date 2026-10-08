import { Module } from '@nestjs/common';
import { InternalUseReturnsController } from './internal-use-returns.controller';
import { InternalUseReturnsService } from './internal-use-returns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule],
  controllers: [InternalUseReturnsController],
  providers: [InternalUseReturnsService],
  exports: [InternalUseReturnsService],
})
export class InternalUseReturnsModule {}

