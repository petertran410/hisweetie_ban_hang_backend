import { Module } from '@nestjs/common';
import { PurchasingPlanningController } from './controllers/purchasing-planning.controller';
import { PurchasingPlanningRepository } from './repositories/purchasing-planning.repository';
import { PurchasingPlanningService } from './services/purchasing-planning.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PurchasingPlanningController],
  providers: [PurchasingPlanningRepository, PurchasingPlanningService],
  exports: [PurchasingPlanningService],
})
export class PurchasingPlanningModule {}
