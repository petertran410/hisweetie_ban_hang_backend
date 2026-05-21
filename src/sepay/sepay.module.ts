import { Module } from '@nestjs/common';
import { SepayController } from './sepay.controller';
import { SepayService } from './sepay.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [PrismaModule, InvoicesModule, OrdersModule],
  controllers: [SepayController],
  providers: [SepayService],
})
export class SepayModule {}
