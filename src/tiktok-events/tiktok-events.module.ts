import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TiktokEventsOutboxService } from './tiktok-events-outbox.service';
import { TiktokEventsApiService } from './tiktok-events-api.service';
import { TiktokEventsWorkerCron } from './tiktok-events-worker.cron';

@Module({
  imports: [PrismaModule],
  providers: [
    TiktokEventsOutboxService,
    TiktokEventsApiService,
    TiktokEventsWorkerCron,
  ],
  exports: [TiktokEventsOutboxService],
})
export class TiktokEventsModule {}
