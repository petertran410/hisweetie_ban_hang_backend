import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InternalFundLedgerService } from './internal-fund-ledger.service';

@Module({
  imports: [PrismaModule],
  providers: [InternalFundLedgerService],
  exports: [InternalFundLedgerService],
})
export class InternalFundLedgerModule {}
