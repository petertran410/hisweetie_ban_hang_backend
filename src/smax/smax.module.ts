import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UploadModule } from '../upload/upload.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { SmaxController } from './smax.controller';
import { SmaxService } from './smax.service';
import { SmaxApiService } from './smax-api.service';
import { SmaxChatController } from './smax-chat.controller';
import { SmaxChatService } from './smax-chat.service';

@Module({
  imports: [PrismaModule, HttpModule, AuditLogsModule, UploadModule, LarkSyncModule],
  controllers: [SmaxController, SmaxChatController],
  providers: [SmaxService, SmaxApiService, SmaxChatService],
  exports: [SmaxService, SmaxApiService],
})
export class SmaxModule {}
