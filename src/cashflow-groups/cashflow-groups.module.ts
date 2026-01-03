import { Module } from '@nestjs/common';
import { CashFlowGroupsController } from './cashflow-groups.controller';
import { CashFlowGroupsService } from './cashflow-groups.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CashFlowGroupsController],
  providers: [CashFlowGroupsService],
  exports: [CashFlowGroupsService],
})
export class CashFlowGroupsModule {}
