import { Module } from '@nestjs/common';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { InventorySnapshotCron } from './inventory-snapshot.cron';

@Module({
  providers: [InventorySnapshotService, InventorySnapshotCron],
  exports: [InventorySnapshotService],
})
export class InventorySnapshotModule {}
