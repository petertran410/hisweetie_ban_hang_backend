import { Module } from '@nestjs/common';
import { ProductQualityController } from './product-quality.controller';
import { ProductQualityService } from './product-quality.service';
import { ProductQualityImportService } from './product-quality-import.service';
import { ProductQualityLarkService } from './product-quality-lark.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    NotificationsModule,
    LarkSyncModule,
    UploadModule,
  ],
  controllers: [ProductQualityController],
  providers: [
    ProductQualityService,
    ProductQualityImportService,
    ProductQualityLarkService,
  ],
  exports: [
    ProductQualityService,
    ProductQualityImportService,
    ProductQualityLarkService,
  ],
})
export class ProductQualityModule {}
