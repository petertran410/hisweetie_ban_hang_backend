import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { ApprovalLifecycleController } from './approval-lifecycle.controller';
import { ApprovalLifecycleService } from './approval-lifecycle.service';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';

@Module({
  imports: [PrismaModule, LarkSyncModule, InternalFundLedgerModule],
  controllers: [ApprovalLifecycleController],
  providers: [ApprovalLifecycleService],
  exports: [ApprovalLifecycleService],
})
export class ApprovalLifecycleModule {}
