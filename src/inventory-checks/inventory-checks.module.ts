import { Module } from '@nestjs/common';
import { InventoryChecksController } from './inventory-checks.controller';
import { InventoryChecksService } from './inventory-checks.service';

@Module({
  controllers: [InventoryChecksController],
  providers: [InventoryChecksService],
  exports: [InventoryChecksService],
})
export class InventoryChecksModule {}
