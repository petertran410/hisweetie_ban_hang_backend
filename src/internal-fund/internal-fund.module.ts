import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ApprovalLifecycleModule } from '../approval-lifecycle/approval-lifecycle.module';
import {
  InternalFundApprovalController,
  InternalFundController,
} from './internal-fund.controller';
import { InternalFundService } from './internal-fund.service';
import { InternalFundLedgerModule } from './internal-fund-ledger.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ApprovalLifecycleModule,
    InternalFundLedgerModule,
  ],
  controllers: [InternalFundController, InternalFundApprovalController],
  providers: [InternalFundService],
  exports: [InternalFundService],
})
export class InternalFundModule {}
