import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MessageIntelController } from './message-intel.controller';
import { MessageIntelService } from './message-intel.service';
import { MessageIntelQueryService } from './message-intel-query.service';
import { MessageIntelExclusionService } from './message-intel-exclusion.service';
import { ContextBuilder } from './context/context-builder';
import { JevProvider } from './providers/jev.provider';
import { IntelDiscoveryService } from './workers/intel-discovery.service';
import { IntelWorkerService } from './workers/intel-worker.service';
import { IntelAlertService } from './workers/intel-alert.service';
import { LarkClientProvider } from '../lark-sync/lark-client.provider';

/**
 * Message Intelligence: phân loại từng tin nhắn khách trong kho Smax bằng TypeSafe Jev. Worker chỉ chạy
 * khi MESSAGE_INTEL_ENABLED=true; không đụng luồng lưu tin / khung chat.
 */
@Module({
  imports: [PrismaModule, HttpModule, AuditLogsModule],
  controllers: [MessageIntelController],
  providers: [
    MessageIntelService,
    MessageIntelQueryService,
    MessageIntelExclusionService,
    ContextBuilder,
    JevProvider,
    IntelDiscoveryService,
    IntelWorkerService,
    IntelAlertService,
    LarkClientProvider,
  ],
  exports: [MessageIntelService, MessageIntelQueryService],
})
export class MessageIntelModule {}
