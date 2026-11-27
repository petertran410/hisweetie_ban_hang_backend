import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { UploadModule } from '../upload/upload.module';
import { PriceChangeController } from './price-change.controller';
import { PriceChangeService } from './price-change.service';
import { PriceChangeConfigService } from './price-change-config.service';
import { PriceChangeReferenceService } from './price-change-reference.service';
import { PriceChangeNotifyService } from './price-change-notify.service';
import { PriceChangeApplyService } from './price-change-apply.service';
import { PriceChangeImportService } from './price-change-import.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    NotificationsModule,
    LarkSyncModule,
    UploadModule,
  ],
  controllers: [PriceChangeController],
  providers: [
    PriceChangeService,
    PriceChangeConfigService,
    PriceChangeReferenceService,
    PriceChangeNotifyService,
    PriceChangeApplyService,
    PriceChangeImportService,
  ],
})
export class PriceChangeModule {}
