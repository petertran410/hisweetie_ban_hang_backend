import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import {
  QuotesController,
  QuoteTemplatesController,
} from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuoteTemplatesService } from './quote-templates.service';
import { QuoteExcelService } from './quote-excel.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [QuotesController, QuoteTemplatesController],
  providers: [QuotesService, QuoteTemplatesService, QuoteExcelService],
})
export class QuotesModule {}
