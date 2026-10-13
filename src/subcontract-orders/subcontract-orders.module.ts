import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SubcontractOrdersController } from './subcontract-orders.controller';
import { SubcontractOrdersService } from './subcontract-orders.service';
import { SubcontractOrderCostingService } from './subcontract-order-costing.service';
import { SubcontractOrderPaymentsService } from './subcontract-order-payments.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [SubcontractOrdersController],
  providers: [
    SubcontractOrdersService,
    SubcontractOrderCostingService,
    SubcontractOrderPaymentsService,
  ],
})
export class SubcontractOrdersModule {}
