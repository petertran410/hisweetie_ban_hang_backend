import type { QuoteListQueryDto } from '../../quotes/dto/quote.dto';
import {
  QUOTE_REGION_LABEL,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABEL,
  type QuoteStatus,
} from '../../quotes/quotes.constants';
import { str, type AiTool } from './common';
import {
  day,
  limiter,
  limitOf,
  limitParameter,
  listMeta,
  pickList,
  TOOL_QUERY_CONCURRENCY,
  vnEndIso,
  vnStartIso,
} from './tool-helpers';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Như frontend (lib/types/quote.ts). */
const CATEGORY_LABEL: Record<string, string> = {
  frozen_topping: 'Topping đông lạnh',
  ambient_topping: 'Topping nhiệt thường',
  powder: 'Bột',
  jam_syrup: 'Mứt/Siro',
};

const regionLabel = (region: string | null) =>
  region
    ? (QUOTE_REGION_LABEL[region as keyof typeof QUOTE_REGION_LABEL] ?? region)
    : null;

export const quotesSummaryTool: AiTool = {
  name: 'quotes_summary',
  label: 'Đang xem báo giá',
  description: (scope) =>
    `Báo giá gửi khách (tab "quotes"): đếm theo trạng thái (Nháp, Đã gửi, Khách chấp nhận, Từ chối, Hết hạn) và danh sách mới nhất (mã BG…, tiêu đề, khách, trạng thái, khu vực, mẫu, ngày áp dụng, hiệu lực đến, người tạo, số dòng sản phẩm). Tab "library" = báo giá mẫu trong thư viện.${
      scope.quoteActor.ownOnly
        ? ' Người hỏi chỉ thấy báo giá mình tạo (thư viện thì thấy hết).'
        : ''
    }`,
  parameters: {
    type: 'object',
    properties: {
      tab: {
        type: 'string',
        enum: ['quotes', 'library'],
        description:
          'quotes = báo giá gửi khách (mặc định), library = thư viện mẫu.',
      },
      search: {
        type: 'string',
        description: 'Mã báo giá, tiêu đề, tên hoặc mã khách.',
      },
      statuses: {
        type: 'array',
        items: { type: 'string', enum: QUOTE_STATUSES },
        description:
          'draft = Nháp, sent = Đã gửi, accepted = Khách chấp nhận, rejected = Từ chối, expired = Hết hạn.',
      },
      from: {
        type: 'string',
        description: 'Tạo từ ngày (YYYY-MM-DD). Bỏ trống = không giới hạn.',
      },
      to: {
        type: 'string',
        description: 'Tạo đến ngày (YYYY-MM-DD, gồm cả ngày này).',
      },
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('quotes:view'),
  async run({ scope, deps }, args) {
    const from = str(args, 'from');
    const to = str(args, 'to');
    if ((from && !DAY.test(from)) || (to && !DAY.test(to)))
      return { error: 'invalid_date: dùng dạng YYYY-MM-DD' };
    if (from && to && from > to)
      return { error: 'invalid_range: from phải trước to' };
    const tab = args.tab === 'library' ? 'library' : 'quotes';
    const actor = scope.quoteActor;
    // Danh sách + đếm từng trạng thái: chạy nhiều nhất 2 lời gọi cùng lúc (pool DB dùng chung với POS).
    const query = limiter(TOOL_QUERY_CONCURRENCY);
    const statuses = pickList(args, 'statuses', QUOTE_STATUSES);
    const base: QuoteListQueryDto = {
      tab,
      search: str(args, 'search'),
      status: statuses,
      fromDate: from ? vnStartIso(from) : undefined,
      toDate: to ? vnEndIso(to) : undefined,
    };

    const countTargets: QuoteStatus[] =
      tab === 'quotes' ? (statuses ?? [...QUOTE_STATUSES]) : [];
    const [list, ...counts] = await Promise.all([
      query(() =>
        deps.quotes.list({ ...base, page: 1, pageSize: limitOf(args) }, actor),
      ),
      ...countTargets.map((status) =>
        query(() =>
          deps.quotes.list({ ...base, status: [status], pageSize: 1 }, actor),
        ),
      ),
    ]);

    const quotes = list.data.map((quote) => ({
      code: quote.code,
      title: quote.title,
      ...(tab === 'quotes'
        ? {
            customer: quote.customer
              ? { code: quote.customer.code, name: quote.customer.name }
              : null,
            status:
              QUOTE_STATUS_LABEL[quote.status as QuoteStatus] ?? quote.status,
            appliedFrom: quote.appliedFrom,
            validUntil: quote.validUntil,
            sentAt: day(quote.sentAt),
            createdBy: quote.createdBy?.name ?? null,
          }
        : {}),
      region: regionLabel(quote.region),
      category: quote.category
        ? (CATEGORY_LABEL[quote.category] ?? quote.category)
        : null,
      template: quote.templateName,
      itemCount: quote.itemCount,
      createdAt: day(quote.createdAt),
    }));

    return {
      tab: tab === 'library' ? 'Thư viện báo giá mẫu' : 'Báo giá gửi khách',
      dataScope:
        tab === 'quotes' && actor.ownOnly
          ? 'Chỉ báo giá người hỏi tạo'
          : 'Mọi báo giá',
      total: list.total,
      ...(countTargets.length
        ? {
            byStatus: Object.fromEntries(
              countTargets
                .map((status, index): [string, number] => [
                  QUOTE_STATUS_LABEL[status],
                  counts[index].total,
                ])
                .filter(([, total]) => Number(total) > 0),
            ),
          }
        : {}),
      quotes,
      ...listMeta(quotes.length, list.total),
    };
  },
};
