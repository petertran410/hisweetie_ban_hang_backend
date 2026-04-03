import { Module } from '@nestjs/common';
import { CashFlowCollectionBranchesController } from './cashflow-collection-branches.controller';
import { CashFlowCollectionBranchesService } from './cashflow-collection-branches.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CashFlowCollectionBranchesController],
  providers: [CashFlowCollectionBranchesService],
  exports: [CashFlowCollectionBranchesService],
})
export class CashFlowCollectionBranchesModule {}
