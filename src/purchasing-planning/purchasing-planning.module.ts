import { Module } from '@nestjs/common';
import { PurchasingPlanningController } from './controllers/purchasing-planning.controller';
import { PurchasingPlanningRepository } from './repositories/purchasing-planning.repository';
import { PurchasingPlanningService } from './services/purchasing-planning.service';
import { PlanningNetworkService } from './services/planning-network.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PurchasingPlanningController],
  providers: [
    PurchasingPlanningRepository,
    PurchasingPlanningService,
    PlanningNetworkService,
  ],
  exports: [PurchasingPlanningService, PlanningNetworkService],
})
export class PurchasingPlanningModule {}
