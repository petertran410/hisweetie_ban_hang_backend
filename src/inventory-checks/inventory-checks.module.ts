import { Module } from '@nestjs/common';
import { InventoryChecksController } from './inventory-checks.controller';
import { InventoryChecksService } from './inventory-checks.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [AuditLogsModule],
  controllers: [InventoryChecksController],
  providers: [InventoryChecksService],
  exports: [InventoryChecksService],
})
export class InventoryChecksModule {}
