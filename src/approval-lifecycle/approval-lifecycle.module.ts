import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { ApprovalLifecycleController } from './approval-lifecycle.controller';
import { ApprovalLifecycleService } from './approval-lifecycle.service';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { InternalFinanceCodeService } from '../internal-finance/internal-finance-code.service';
import { LarkApprovalMirrorService } from './lark-approval-mirror.service';

@Module({
  imports: [PrismaModule, LarkSyncModule, InternalFundLedgerModule],
  controllers: [ApprovalLifecycleController],
  providers: [
    ApprovalLifecycleService,
    LarkApprovalMirrorService,
    InternalFinanceCodeService,
  ],
  exports: [ApprovalLifecycleService],
})
export class ApprovalLifecycleModule {}
