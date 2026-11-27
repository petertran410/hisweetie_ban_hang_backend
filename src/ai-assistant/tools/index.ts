import type { AiTool } from './common';
import { invoicesSummaryTool } from './invoices-summary.tool';
import { ordersSummaryTool } from './orders-summary.tool';
import { customerLookupTool } from './customer-lookup.tool';
import { customerDebtsTool } from './customer-debts.tool';
import { stockLevelsTool } from './stock-levels.tool';
import { leadsSummaryTool } from './leads-summary.tool';
import { quotesSummaryTool } from './quotes-summary.tool';
import { revenueSummaryTool } from './revenue-summary.tool';
import { smaxChatsTool } from './smax-chats.tool';
import { smaxMessageLabelsTool } from './smax-message-labels.tool';

/** Mọi công cụ của trợ lý, theo thứ tự gửi cho model. */
export const AI_TOOLS: AiTool[] = [
  revenueSummaryTool,
  invoicesSummaryTool,
  ordersSummaryTool,
  customerLookupTool,
  customerDebtsTool,
  stockLevelsTool,
  leadsSummaryTool,
  quotesSummaryTool,
  smaxChatsTool,
  smaxMessageLabelsTool,
];
