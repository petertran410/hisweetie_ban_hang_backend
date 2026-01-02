import { Module } from '@nestjs/common';
import { CashFlowsController } from './cashflows.controller';
import { CashFlowsService } from './cashflows.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CashFlowsController],
  providers: [CashFlowsService],
  exports: [CashFlowsService],
})
export class CashFlowsModule {}
