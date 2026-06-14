import { Module } from '@nestjs/common';
import { ConsignmentReturnsController } from './consignment-returns.controller';
import { ConsignmentReturnsService } from './consignment-returns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsignmentsModule } from '../consignments/consignments.module';

@Module({
  imports: [PrismaModule, ConsignmentsModule],
  controllers: [ConsignmentReturnsController],
  providers: [ConsignmentReturnsService],
  exports: [ConsignmentReturnsService],
})
export class ConsignmentReturnsModule {}
