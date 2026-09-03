import { Module } from '@nestjs/common';
import { DebtTicketsController } from './debt-tickets.controller';
import { DebtTicketsService } from './debt-tickets.service';
import { DebtTicketAutoCloseService } from './debt-ticket-auto-close.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DebtTrackingModule } from '../debt-tracking/debt-tracking.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [PrismaModule, DebtTrackingModule, LarkSyncModule],
  controllers: [DebtTicketsController],
  providers: [
    DebtTicketsService,
    DebtTicketAutoCloseService,
  ],
  exports: [DebtTicketsService, DebtTicketAutoCloseService],
})
export class DebtTicketsModule {}
