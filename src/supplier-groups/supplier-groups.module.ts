import { Module } from '@nestjs/common';
import { SupplierGroupsController } from './supplier-groups.controller';
import { SupplierGroupsService } from './supplier-groups.service';

@Module({
  controllers: [SupplierGroupsController],
  providers: [SupplierGroupsService],
  exports: [SupplierGroupsService],
})
export class SupplierGroupsModule {}
