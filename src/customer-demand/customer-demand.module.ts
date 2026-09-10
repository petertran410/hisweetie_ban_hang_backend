import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerDemandController } from './controllers/customer-demand.controller';
import { CustomerDemandRepository } from './repositories/customer-demand.repository';
import { CustomerDemandImportService } from './services/customer-demand-import.service';
import { CustomerDemandService } from './services/customer-demand.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [CustomerDemandController],
  providers: [
    CustomerDemandRepository,
    CustomerDemandService,
    CustomerDemandImportService,
  ],
  exports: [CustomerDemandService, CustomerDemandRepository],
})
export class CustomerDemandModule {}
