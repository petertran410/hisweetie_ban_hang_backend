import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ManufacturersController, PayablesController } from './manufacturers.controller';
import { ManufacturersService } from './manufacturers.service';
import { ExternalProductionsService } from './external-productions.service';
import { PayablesService } from './payables.service';
import { ManufacturerStockService } from './manufacturer-stock.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [ManufacturersController, PayablesController],
  providers: [ManufacturersService, ExternalProductionsService, PayablesService, ManufacturerStockService],
  exports: [ManufacturersService, ExternalProductionsService, PayablesService, ManufacturerStockService],
})
export class ManufacturersModule {}
