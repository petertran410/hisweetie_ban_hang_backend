import { Module } from '@nestjs/common';
import { ConsignmentsController } from './consignments.controller';
import { ConsignmentsService } from './consignments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, LarkSyncModule],
  controllers: [ConsignmentsController],
  providers: [ConsignmentsService],
  exports: [ConsignmentsService],
})
export class ConsignmentsModule {}
