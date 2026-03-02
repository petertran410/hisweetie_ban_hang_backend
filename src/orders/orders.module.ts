import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderPaymentsController } from './order-payments.controller';
import { OrderPaymentsService } from './order-payments.service';
import { PriceBooksModule } from '../price-books/price-books.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, PriceBooksModule, AuditLogsModule],
  controllers: [OrdersController, OrderPaymentsController],
  providers: [OrdersService, OrderPaymentsService],
  exports: [OrdersService, OrderPaymentsService],
})
export class OrdersModule {}
