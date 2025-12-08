import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ProductsModule } from '../products/products.module';
import { OrdersModule } from '../orders/orders.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [ProductsModule, OrdersModule, CustomersModule],
  controllers: [ExportController],
  providers: [ExportService],
})
export class ExportModule {}
