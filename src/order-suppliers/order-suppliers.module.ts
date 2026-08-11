import { Module } from '@nestjs/common';
import { OrderSuppliersController } from './order-suppliers.controller';
import { OrderSuppliersService } from './order-suppliers.service';
import { OrderSupplierPaymentsService } from './order-supplier-payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { FactoryProductsModule } from '../factory-products/factory-products.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, FactoryProductsModule],
  controllers: [OrderSuppliersController],
  providers: [OrderSuppliersService, OrderSupplierPaymentsService],
  exports: [OrderSuppliersService, OrderSupplierPaymentsService],
})
export class OrderSuppliersModule {}
