import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module';
import { OrderSuppliersModule } from '../order-suppliers/order-suppliers.module';
import { AuthModule } from '../auth/auth.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    OrdersModule,
    OrderSuppliersModule,
    AuthModule,
    LarkSyncModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
