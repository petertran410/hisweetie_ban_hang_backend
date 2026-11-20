import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import {
  PublicPriceAdminController,
  PublicPriceController,
} from './public-price.controller';
import { PublicPriceService } from './public-price.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PublicPriceAdminController, PublicPriceController],
  providers: [PublicPriceService],
})
export class PublicPriceModule {}
