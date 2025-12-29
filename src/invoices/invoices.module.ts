import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InvoicesController, InvoicePaymentsController],
  providers: [InvoicesService, InvoicePaymentsService],
  exports: [InvoicesService, InvoicePaymentsService],
})
export class InvoicesModule {}
