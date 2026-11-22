import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { OrdersModule } from '../orders/orders.module';
import { CustomersModule } from '../customers/customers.module';
import { DebtTrackingModule } from '../debt-tracking/debt-tracking.module';
import { InventoriesModule } from '../inventories/inventories.module';
import { LeadsModule } from '../leads/leads.module';
import { QuotesModule } from '../quotes/quotes.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantCron } from './ai-assistant.cron';
import { AiChatService } from './ai-chat.service';
import { AiToolsService } from './tools/ai-tools.service';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    // Service sẵn có mà công cụ của trợ lý gọi lại (chỉ đọc)
    InvoicesModule,
    OrdersModule,
    CustomersModule,
    DebtTrackingModule,
    InventoriesModule,
    LeadsModule,
    QuotesModule,
    DashboardModule,
  ],
  controllers: [AiAssistantController],
  providers: [AiChatService, AiToolsService, AiAssistantCron],
})
export class AiAssistantModule {}
