import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { LarkClientProvider } from './lark-client.provider';
import { LarkBaseService } from './services/lark-base.service';
import { LarkOrderSyncService } from './services/lark-order-sync.service';
import { LarkOrderNotificationService } from './services/lark-order-notification.service';
import { LarkSyncController } from './lark-sync.controller';
import { LarkSyncCron } from './lark-sync.cron';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [LarkSyncController],
  providers: [
    LarkClientProvider,
    LarkBaseService,
    LarkOrderSyncService,
    LarkOrderNotificationService,
    LarkSyncCron,
  ],
  exports: [LarkOrderSyncService, LarkOrderNotificationService],
})
export class LarkSyncModule {}
