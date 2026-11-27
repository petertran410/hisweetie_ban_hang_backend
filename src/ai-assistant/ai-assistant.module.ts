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
import { SmaxModule } from '../smax/smax.module';
import { MessageIntelModule } from '../message-intel/message-intel.module';
import { PriceBooksModule } from '../price-books/price-books.module';
import { AiComposeController } from './compose/ai-compose.controller';
import { AiComposeService } from './compose/ai-compose.service';
import { UpsellService } from './compose/upsell.service';
import { DailyReportService } from './compose/daily-report.service';
import { DailyReportCron } from './compose/daily-report.cron';
import { LarkClientProvider } from '../lark-sync/lark-client.provider';
import {
  AiAssistantController,
  AiSharedController,
} from './ai-assistant.controller';
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
    SmaxModule,
    MessageIntelModule,
    PriceBooksModule,
  ],
  controllers: [AiAssistantController, AiSharedController, AiComposeController],
  providers: [
    AiChatService,
    AiToolsService,
    AiAssistantCron,
    AiComposeService,
    UpsellService,
    DailyReportService,
    DailyReportCron,
    // Chỉ cần client Lark để gửi báo cáo (không kéo cả LarkSyncModule)
    LarkClientProvider,
  ],
})
export class AiAssistantModule {}
