import { Module } from '@nestjs/common';
import { ConsignmentReturnsController } from './consignment-returns.controller';
import { ConsignmentReturnsService } from './consignment-returns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsignmentsModule } from '../consignments/consignments.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, ConsignmentsModule, LarkSyncModule],
  controllers: [ConsignmentReturnsController],
  providers: [ConsignmentReturnsService],
  exports: [ConsignmentReturnsService],
})
export class ConsignmentReturnsModule {}
