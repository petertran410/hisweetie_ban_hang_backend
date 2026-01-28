import { Module } from '@nestjs/common';
import { OrderSuppliersController } from './order-suppliers.controller';
import { OrderSuppliersService } from './order-suppliers.service';
import { OrderSupplierPaymentsService } from './order-supplier-payments.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [OrderSuppliersController],
  providers: [OrderSuppliersService, OrderSupplierPaymentsService],
  exports: [OrderSuppliersService, OrderSupplierPaymentsService],
})
export class OrderSuppliersModule {}
