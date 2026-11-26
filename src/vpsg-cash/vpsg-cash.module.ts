import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { VpsgCashController } from './vpsg-cash.controller';
import { VpsgCashService } from './vpsg-cash.service';
import { FinanceAuditModule } from '../finance-audit/finance-audit.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    InternalFundLedgerModule,
    FinanceAuditModule,
  ],
  controllers: [VpsgCashController],
  providers: [VpsgCashService],
})
export class VpsgCashModule {}
