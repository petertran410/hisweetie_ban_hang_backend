import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { LARK_CLIENT, LarkClientProvider } from './lark-client.provider';
import { LarkBaseService } from './services/lark-base.service';
import { LarkOrderSyncService } from './services/lark-order-sync.service';
import { LarkOrderNotificationService } from './services/lark-order-notification.service';
import { LarkLoadingNotificationService } from './services/lark-loading-notification.service';
import { LarkUserDirectoryService } from './services/lark-user-directory.service';
import { LarkCustomerBaseService } from './services/lark-customer-base.service';
import { LarkCustomerSyncService } from './services/lark-customer-sync.service';
import { LarkProductBaseService } from './services/lark-product-base.service';
import { LarkProductSyncService } from './services/lark-product-sync.service';
import { LarkSyncController } from './lark-sync.controller';
import { LarkSyncCron } from './lark-sync.cron';
import { LarkDebtNotificationService } from './services/lark-debt-notification.service';
import { LarkExpenseReviewNotificationService } from './services/lark-expense-review-notification.service';
import { LarkSecurityNotificationService } from './services/lark-security-notification.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [LarkSyncController],
  providers: [
    LarkClientProvider,
    LarkBaseService,
    LarkOrderSyncService,
    LarkOrderNotificationService,
    LarkLoadingNotificationService,
    LarkUserDirectoryService,
    LarkCustomerBaseService,
    LarkCustomerSyncService,
    LarkProductBaseService,
    LarkProductSyncService,
    LarkSyncCron,
    LarkDebtNotificationService,
    LarkExpenseReviewNotificationService,
    LarkSecurityNotificationService,
  ],
  exports: [
    LARK_CLIENT,
    LarkOrderSyncService,
    LarkOrderNotificationService,
    LarkLoadingNotificationService,
    LarkCustomerSyncService,
    LarkProductSyncService,
    LarkDebtNotificationService,
    LarkExpenseReviewNotificationService,
    LarkUserDirectoryService,
  ],
})
export class LarkSyncModule {}
