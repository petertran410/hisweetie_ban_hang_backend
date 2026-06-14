import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module';
import { ConsignmentsModule } from '../consignments/consignments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PackingSlipsModule } from '../packing-slips/packing-slips.module';
import { PromotionsModule } from '../promotions/promotions.module';

@Module({
  imports: [
    PrismaModule,
    OrdersModule,
    ConsignmentsModule,
    AuditLogsModule,
    PackingSlipsModule,
    PromotionsModule,
  ],
  controllers: [InvoicesController, InvoicePaymentsController],
  providers: [InvoicesService, InvoicePaymentsService],
  exports: [InvoicesService, InvoicePaymentsService],
})
export class InvoicesModule {}
