import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PaymentNotesController } from './payment-notes.controller';
import { PaymentNotesService } from './payment-notes.service';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PaymentNotesController],
  providers: [PaymentNotesService],
  exports: [PaymentNotesService],
})
export class PaymentNotesModule {}
