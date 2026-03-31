import { Module } from '@nestjs/common';
import { ReturnOrdersController } from './return-orders.controller';
import { ReturnOrdersService } from './return-orders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [ReturnOrdersController],
  providers: [ReturnOrdersService],
  exports: [ReturnOrdersService],
})
export class ReturnOrdersModule {}
