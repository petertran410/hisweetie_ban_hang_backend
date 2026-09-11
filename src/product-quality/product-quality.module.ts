import { Module } from '@nestjs/common';
import { ProductQualityController } from './product-quality.controller';
import { ProductQualityService } from './product-quality.service';
import { ProductQualityImportService } from './product-quality-import.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, NotificationsModule, LarkSyncModule],
  controllers: [ProductQualityController],
  providers: [ProductQualityService, ProductQualityImportService],
  exports: [ProductQualityService, ProductQualityImportService],
})
export class ProductQualityModule {}
