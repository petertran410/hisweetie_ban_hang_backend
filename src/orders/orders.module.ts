import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderPaymentsController } from './order-payments.controller';
import { OrderPaymentsService } from './order-payments.service';
import { PriceBooksModule } from 'src/price-books/price-books.module';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule, PriceBooksModule],
  controllers: [OrdersController, OrderPaymentsController],
  providers: [OrdersService, OrderPaymentsService],
  exports: [OrdersService, OrderPaymentsService],
})
export class OrdersModule {}
