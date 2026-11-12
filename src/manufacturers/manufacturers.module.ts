import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ManufacturersController, PayablesController } from './manufacturers.controller';
import { ManufacturersService } from './manufacturers.service';
import { ExternalProductionsService } from './external-productions.service';
import { PayablesService } from './payables.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [ManufacturersController, PayablesController],
  providers: [ManufacturersService, ExternalProductionsService, PayablesService],
  exports: [ManufacturersService, ExternalProductionsService, PayablesService],
})
export class ManufacturersModule {}
