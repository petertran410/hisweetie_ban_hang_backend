import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MetaPurchaseOutboxService } from './meta-purchase-outbox.service';
import { MetaConversionsApiService } from './meta-conversions-api.service';
import { MetaPurchaseWorkerCron } from './meta-purchase-worker.cron';

@Module({
  imports: [PrismaModule],
  providers: [
    MetaPurchaseOutboxService,
    MetaConversionsApiService,
    MetaPurchaseWorkerCron,
  ],
  exports: [MetaPurchaseOutboxService],
})
export class MetaPurchaseModule {}