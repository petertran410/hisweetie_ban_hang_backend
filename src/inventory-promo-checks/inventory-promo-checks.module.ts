import { Module } from '@nestjs/common';
import { InventoryPromoChecksController } from './inventory-promo-checks.controller';
import { InventoryPromoChecksService } from './inventory-promo-checks.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [AuditLogsModule],
  controllers: [InventoryPromoChecksController],
  providers: [InventoryPromoChecksService],
  exports: [InventoryPromoChecksService],
})
export class InventoryPromoChecksModule {}
