import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InternalFundLedgerModule } from '../internal-fund/internal-fund-ledger.module';
import { VpsgCashController } from './vpsg-cash.controller';
import { VpsgCashService } from './vpsg-cash.service';

@Module({
  imports: [PrismaModule, AuthModule, InternalFundLedgerModule],
  controllers: [VpsgCashController],
  providers: [VpsgCashService],
})
export class VpsgCashModule {}
