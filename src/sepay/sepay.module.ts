import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { SepayController } from './sepay.controller';
import { SepayService } from './sepay.service';
import { SepaySyncService } from './sepay-sync.service';
import { SepayMatchService } from './sepay-match.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { OrdersModule } from '../orders/orders.module';
import { CashFlowsModule } from '../cashflows/cashflows.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    InvoicesModule,
    OrdersModule,
    CashFlowsModule,
    AuthModule,
    NotificationsModule,
    HttpModule.register({ timeout: 120000, maxRedirects: 5 }),
  ],
  controllers: [SepayController],
  providers: [SepayService, SepaySyncService, SepayMatchService],
})
export class SepayModule {}
