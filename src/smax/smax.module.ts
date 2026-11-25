import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UploadModule } from '../upload/upload.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { LeadLinkModule } from '../leads/lead-link/lead-link.module';
import { SmaxController } from './smax.controller';
import { SmaxService } from './smax.service';
import { SmaxApiService } from './smax-api.service';
import { SmaxChatController } from './smax-chat.controller';
import { SmaxChatService } from './smax-chat.service';
import { SmaxArchiveService } from './smax-archive.service';
import { SmaxArchiveSyncService } from './smax-archive-sync.service';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';
import { SmaxReportsController } from './smax-reports/smax-reports.controller';
import { SmaxReportsService } from './smax-reports/smax-reports.service';

@Module({
  imports: [PrismaModule, HttpModule, AuditLogsModule, UploadModule, LarkSyncModule, LeadLinkModule],
  controllers: [
    SmaxController,
    SmaxChatController,
    QuickRepliesController,
    SmaxReportsController,
  ],
  providers: [
    SmaxService,
    SmaxApiService,
    SmaxChatService,
    QuickRepliesService,
    SmaxReportsService,
    SmaxArchiveService,
    SmaxArchiveSyncService,
  ],
  exports: [SmaxService, SmaxApiService, SmaxChatService, SmaxArchiveService],
})
export class SmaxModule {}
