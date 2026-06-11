import { Module } from '@nestjs/common';
import { VehicleShipmentsController } from './vehicle-shipments.controller';
import { VehicleShipmentsService } from './vehicle-shipments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, PurchaseOrdersModule],
  controllers: [VehicleShipmentsController],
  providers: [VehicleShipmentsService],
  exports: [VehicleShipmentsService],
})
export class VehicleShipmentsModule {}
