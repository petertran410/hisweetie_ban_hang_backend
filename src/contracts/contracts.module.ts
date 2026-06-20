import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DocumensoClient } from './documenso.client';
import { PdfBurnService } from './pdf-burn.service';
import { LarkMailService } from './lark-mail.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    DocumensoClient,
    PdfBurnService,
    LarkMailService,
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
