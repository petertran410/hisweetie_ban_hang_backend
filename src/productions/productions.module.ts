import { Module } from '@nestjs/common';
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, PurchaseOrdersModule],
  controllers: [ProductionsController],
  providers: [ProductionsService],
  exports: [ProductionsService],
})
export class ProductionsModule {}
