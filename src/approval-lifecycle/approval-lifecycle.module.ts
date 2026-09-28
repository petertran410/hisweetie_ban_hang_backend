import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { CashFlowsModule } from '../cashflows/cashflows.module';
import { ApprovalLifecycleController } from './approval-lifecycle.controller';
import { ApprovalLifecycleService } from './approval-lifecycle.service';

@Module({
  imports: [PrismaModule, LarkSyncModule, CashFlowsModule],
  controllers: [ApprovalLifecycleController],
  providers: [ApprovalLifecycleService],
  exports: [ApprovalLifecycleService],
})
export class ApprovalLifecycleModule {}
