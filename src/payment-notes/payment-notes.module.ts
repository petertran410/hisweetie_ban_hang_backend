import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentNotesController } from './payment-notes.controller';
import { PaymentNotesService } from './payment-notes.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentNotesController],
  providers: [PaymentNotesService],
  exports: [PaymentNotesService],
})
export class PaymentNotesModule {}
