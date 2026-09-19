import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerDemandController } from './controllers/customer-demand.controller';
import { CustomerDemandRepository } from './repositories/customer-demand.repository';
import { CustomerDemandImportService } from './services/customer-demand-import.service';
import { CustomerDemandService } from './services/customer-demand.service';
import { LarkCustomerDemandSyncService } from './services/lark-customer-demand-sync.service';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule],
  controllers: [CustomerDemandController],
  providers: [
    CustomerDemandRepository,
    CustomerDemandService,
    CustomerDemandImportService,
    LarkCustomerDemandSyncService,
  ],
  exports: [CustomerDemandService, CustomerDemandRepository],
})
export class CustomerDemandModule {}
