import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoicesService } from '../../invoices/invoices.service';
import { OrdersService } from '../../orders/orders.service';
import { CustomersService } from '../../customers/customers.service';
import { DebtTrackingService } from '../../debt-tracking/debt-tracking.service';
import { InventoriesService } from '../../inventories/inventories.service';
import { LeadsService } from '../../leads/leads.service';
import { QuotesService } from '../../quotes/quotes.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { SmaxChatService } from '../../smax/smax-chat.service';
import type { AiTool } from './common';
import type { AiToolDeps } from './deps';
import { AI_TOOLS } from './index';

/** Gom service sẵn có cho công cụ của trợ lý. */
@Injectable()
export class AiToolsService {
  readonly tools: AiTool[] = AI_TOOLS;
  readonly deps: AiToolDeps;

  constructor(
    prisma: PrismaService,
    invoices: InvoicesService,
    orders: OrdersService,
    customers: CustomersService,
    debtTracking: DebtTrackingService,
    inventories: InventoriesService,
    leads: LeadsService,
    quotes: QuotesService,
    dashboard: DashboardService,
    smaxChat: SmaxChatService,
  ) {
    this.deps = {
      prisma,
      invoices,
      orders,
      customers,
      debtTracking,
      inventories,
      leads,
      quotes,
      dashboard,
      smaxChat,
    };
  }
}
