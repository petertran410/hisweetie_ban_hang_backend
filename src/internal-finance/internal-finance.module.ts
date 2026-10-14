import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CashFlowsModule } from '../cashflows/cashflows.module';
import { ApprovalLifecycleModule } from '../approval-lifecycle/approval-lifecycle.module';
import { UploadModule } from '../upload/upload.module';
import { InternalFinanceController } from './internal-finance.controller';
import { InternalFinanceService } from './internal-finance.service';
import { InternalFinanceCodeService } from './internal-finance-code.service';
import { AuthModule } from '../auth/auth.module';
import { InternalFundModule } from '../internal-fund/internal-fund.module';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { WarehouseExpenseNotesService } from './warehouse-expense-notes.service';

@Module({
  imports: [
    PrismaModule,
    CashFlowsModule,
    ApprovalLifecycleModule,
    UploadModule,
    AuthModule,
    InternalFundModule,
    InternalFundLedgerModule,
    VehiclesModule,
    LarkSyncModule,
  ],
  controllers: [InternalFinanceController],
  providers: [
    InternalFinanceService,
    InternalFinanceCodeService,
    WarehouseExpenseNotesService,
  ],
  exports: [InternalFinanceService],
})
export class InternalFinanceModule {}
