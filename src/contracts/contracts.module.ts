import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DocumensoClient } from './documenso.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule],
  controllers: [ContractsController],
  providers: [ContractsService, DocumensoClient],
  exports: [ContractsService],
})
export class ContractsModule {}
