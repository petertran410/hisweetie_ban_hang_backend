import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MisaAuthService } from './misa-auth.service';
import { MisaDictionaryService } from './misa-dictionary.service';
import { MisaVoucherService } from './misa-voucher.service';
import { MisaSyncController } from './misa-sync.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 60000,
      maxRedirects: 5,
    }),
    ConfigModule,
    PrismaModule,
  ],
  controllers: [MisaSyncController],
  providers: [MisaAuthService, MisaDictionaryService, MisaVoucherService],
  exports: [MisaAuthService, MisaDictionaryService, MisaVoucherService],
})
export class MisaSyncModule {}
