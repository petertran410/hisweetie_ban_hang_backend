import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { InternalFinanceCodeService } from '../internal-finance/internal-finance-code.service';
import {
  CashAdvanceRefundsController,
  CashAdvancesController,
} from './cash-advances.controller';
import { CashAdvancesService } from './cash-advances.service';
import { CashAdvanceRefundsService } from './cash-advance-refunds.service';

@Module({
  imports: [PrismaModule, AuthModule, InternalFundLedgerModule],
  controllers: [CashAdvancesController, CashAdvanceRefundsController],
  providers: [
    CashAdvancesService,
    CashAdvanceRefundsService,
    InternalFinanceCodeService,
  ],
  exports: [CashAdvancesService],
})
export class CashAdvancesModule {}
