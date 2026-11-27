import type { PrismaService } from '../../prisma/prisma.service';
import type { InvoicesService } from '../../invoices/invoices.service';
import type { OrdersService } from '../../orders/orders.service';
import type { CustomersService } from '../../customers/customers.service';
import type { DebtTrackingService } from '../../debt-tracking/debt-tracking.service';
import type { InventoriesService } from '../../inventories/inventories.service';
import type { LeadsService } from '../../leads/leads.service';
import type { QuotesService } from '../../quotes/quotes.service';
import type { DashboardService } from '../../dashboard/dashboard.service';
import type { SmaxChatService } from '../../smax/smax-chat.service';
import type { SmaxArchiveService } from '../../smax/smax-archive.service';
import type { MessageIntelQueryService } from '../../message-intel/message-intel-query.service';

/** Service sẵn có mà công cụ gọi lại (AiToolsService tiêm vào). */
export interface AiToolDeps {
  prisma: PrismaService;
  invoices: InvoicesService;
  orders: OrdersService;
  customers: CustomersService;
  debtTracking: DebtTrackingService;
  inventories: InventoriesService;
  leads: LeadsService;
  quotes: QuotesService;
  dashboard: DashboardService;
  smaxChat: SmaxChatService;
  /** Kho tin Smax trên DB — kênh đã lưu đủ khoảng ngày thì đọc DB thay vì gọi Smax. */
  smaxArchive?: SmaxArchiveService;
  /** Nhãn AI từng tin nhắn (Message Intelligence) — tool smax_message_labels. */
  messageIntel?: MessageIntelQueryService;
}
