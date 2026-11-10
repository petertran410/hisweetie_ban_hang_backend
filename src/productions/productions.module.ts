import { Module } from '@nestjs/common';
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { ManufacturersModule } from '../manufacturers/manufacturers.module';
import { AuthModule } from '../auth/auth.module';
import { ProductionCostService } from './production-cost.service';
import { ProductionCostHistoryService } from './production-cost-history.service';

@Module({
  imports: [PrismaModule, AuditLogsModule, PurchaseOrdersModule, ManufacturersModule, AuthModule],
  controllers: [ProductionsController],
  providers: [ProductionsService, ProductionCostService, ProductionCostHistoryService],
  exports: [ProductionsService],
})
export class ProductionsModule {}
