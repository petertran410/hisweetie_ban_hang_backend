import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DocumensoClient } from './documenso.client';
import { PdfBurnService } from './pdf-burn.service';
import { LarkMailService } from './lark-mail.service';
import { ContractsDocumensoSyncCron } from './contracts-documenso-sync.cron';
import { SettingsModule } from '../settings/settings.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule, SettingsModule],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    DocumensoClient,
    PdfBurnService,
    LarkMailService,
    ContractsDocumensoSyncCron,
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
