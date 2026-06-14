import { Module } from '@nestjs/common';
import { ConsignmentsController } from './consignments.controller';
import { ConsignmentsService } from './consignments.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConsignmentsController],
  providers: [ConsignmentsService],
  exports: [ConsignmentsService],
})
export class ConsignmentsModule {}
