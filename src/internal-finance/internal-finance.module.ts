import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CashFlowsModule } from '../cashflows/cashflows.module';
import { ApprovalLifecycleModule } from '../approval-lifecycle/approval-lifecycle.module';
import { UploadModule } from '../upload/upload.module';
import { InternalFinanceController } from './internal-finance.controller';
import { InternalFinanceService } from './internal-finance.service';
import { InternalFinanceLarkImportService } from './internal-finance-lark-import.service';
import { LarkFinanceImportClient } from './lark-finance-import.client';
import { InternalFinanceCodeService } from './internal-finance-code.service';
import { AuthModule } from '../auth/auth.module';
import { InternalFundModule } from '../internal-fund/internal-fund.module';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { VehiclesModule } from '../vehicles/vehicles.module';

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
  ],
  controllers: [InternalFinanceController],
  providers: [
    InternalFinanceService,
    InternalFinanceLarkImportService,
    LarkFinanceImportClient,
    InternalFinanceCodeService,
  ],
  exports: [InternalFinanceService],
})
export class InternalFinanceModule {}
