import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InternalFundLedgerService } from './internal-fund-ledger.service';
import { FinanceAuditModule } from '../finance-audit/finance-audit.module';

@Module({
  imports: [PrismaModule, FinanceAuditModule],
  providers: [InternalFundLedgerService],
  exports: [InternalFundLedgerService],
})
export class InternalFundLedgerModule {}
