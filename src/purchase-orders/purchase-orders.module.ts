import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrderPaymentsService } from './purchase-order-payments.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService, PurchaseOrderPaymentsService],
  exports: [PurchaseOrdersService, PurchaseOrderPaymentsService],
})
export class PurchaseOrdersModule {}
