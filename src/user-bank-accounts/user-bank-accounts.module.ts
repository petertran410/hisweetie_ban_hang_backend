import { Module } from '@nestjs/common';
import { UserBankAccountsController } from './user-bank-accounts.controller';
import { UserBankAccountsService } from './user-bank-accounts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UserBankAccountsController],
  providers: [UserBankAccountsService],
  exports: [UserBankAccountsService],
})
export class UserBankAccountsModule {}
