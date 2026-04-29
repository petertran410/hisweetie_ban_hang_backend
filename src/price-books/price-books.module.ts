import { Module } from '@nestjs/common';
import { PriceBooksController } from './price-books.controller';
import { PriceBooksService } from './price-books.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from 'src/audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PriceBooksController],
  providers: [PriceBooksService],
  exports: [PriceBooksService],
})
export class PriceBooksModule {}
