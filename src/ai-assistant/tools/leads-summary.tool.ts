import type { LeadListQueryDto } from '../../leads/dto/lead.dto';
import {
  LEAD_CATEGORY_LABEL,
  LEAD_SOURCES,
  LEAD_SOURCE_LABEL,
  LEAD_STATUSES,
  LEAD_STATUS_LABEL,
  leadCode,
} from '../../leads/leads.constants';
import { str, type AiTool } from './common';
import {
  day,
  limitOf,
  limitParameter,
  listMeta,
  pickList,
  vnEndIso,
  vnStartIso,
} from './tool-helpers';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Số kênh tối đa đem đếm khi nhóm theo kênh. */
const MAX_CHANNELS = 30;

export const leadsSummaryTool: AiTool = {
  name: 'leads_summary',
  label: 'Đang xem lead',
  description: (scope) =>
    `Lead (khách tiềm năng CSKH chăm sóc rồi chuyển Sale): đếm lead theo trạng thái và nguồn (tuỳ chọn thêm theo kênh), danh sách lead mới nhất (mã LEAD…, tên, phân loại, trạng thái, nguồn, kênh, Sale PIC, khách POS đã gắn, ngày tạo). Lọc theo khoảng ngày tạo, trạng thái, nguồn, tên / mã lead. Không trả SĐT.${
      scope.leadActor.ownOnly ? ' Người hỏi chỉ thấy lead giao cho mình.' : ''
    }`,
  parameters: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description:
          'Tạo từ ngày (YYYY-MM-DD, giờ VN). Bỏ trống = không giới hạn.',
      },
      to: {
        type: 'string',
        description: 'Tạo đến ngày (YYYY-MM-DD, gồm cả ngày này).',
      },
      statuses: {
        type: 'array',
        items: { type: 'string', enum: LEAD_STATUSES },
        description:
          'new = Mới, caring = Đang chăm sóc, handed_over = Đã chuyển Sale, converted = Đã chuyển đổi, cancelled = Huỷ.',
      },
      sources: {
        type: 'array',
        items: { type: 'string', enum: LEAD_SOURCES },
        description:
          'facebook = Fanpage, tiktok, shopee, zalo_oa, zalo_user, website, direct = Trực tiếp, other = Khác.',
      },
      search: {
        type: 'string',
        description: 'Tên lead hoặc mã LEAD…',
      },
      byChannel: {
        type: 'boolean',
        description: 'true = đếm thêm theo kênh (page) khách nhắn tới.',
      },
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('leads:view'),
  async run({ scope, deps }, args) {
    const from = str(args, 'from');
    const to = str(args, 'to');
    if ((from && !DAY.test(from)) || (to && !DAY.test(to)))
      return { error: 'invalid_date: dùng dạng YYYY-MM-DD' };
    if (from && to && from > to)
      return { error: 'invalid_range: from phải trước to' };
    const actor = scope.leadActor;
    const base: LeadListQueryDto = {
      q: str(args, 'search'),
      statuses: pickList(args, 'statuses', LEAD_STATUSES)?.join(','),
      sources: pickList(args, 'sources', LEAD_SOURCES)?.join(','),
      from: from ? vnStartIso(from) : undefined,
      to: to ? vnEndIso(to) : undefined,
    };
    const countWith = async (extra: Partial<LeadListQueryDto>) =>
      (await deps.leads.list({ ...base, ...extra, limit: 1 }, actor)).total;
    // Đếm theo từng giá trị, giữ bộ lọc model đã chọn (giao nhau).
    const countEach = async (
      key: 'statuses' | 'sources' | 'channels',
      values: readonly string[],
      labels: Record<string, string>,
    ) => {
      const picked = base[key]?.split(',');
      const targets = picked
        ? values.filter((v) => picked.includes(v))
        : values;
      const totals = await Promise.all(
        targets.map((value) => countWith({ [key]: value })),
      );
      return Object.fromEntries(
        targets
          .map((value, index): [string, number] => [
            labels[value] ?? value,
            totals[index],
          ])
          .filter(([, total]) => Number(total) > 0),
      );
    };

    const [list, byStatus, bySource] = await Promise.all([
      deps.leads.list({ ...base, limit: limitOf(args), page: 1 }, actor),
      countEach('statuses', LEAD_STATUSES, LEAD_STATUS_LABEL),
      countEach('sources', LEAD_SOURCES, LEAD_SOURCE_LABEL),
    ]);

    let byChannel: Record<string, unknown> | undefined;
    if (args.byChannel === true) {
      const channels = (
        await deps.leads.channelFilterOptions(base.sources)
      ).slice(0, MAX_CHANNELS);
      byChannel = await countEach('channels', channels, {});
    }

    const leads = list.data.map((lead) => ({
      code: leadCode(lead.id),
      name: lead.name,
      category: LEAD_CATEGORY_LABEL[lead.category] ?? lead.category,
      status: LEAD_STATUS_LABEL[lead.status] ?? lead.status,
      source: LEAD_SOURCE_LABEL[lead.source] ?? lead.source,
      channel: lead.channelName ?? null,
      salePic: lead.salePic?.name ?? null,
      cskh: lead.cskhUser?.name ?? null,
      customers: lead.customers.map((customer) => ({
        code: customer.code,
        name: customer.name,
      })),
      createdAt: day(lead.createdAt),
      convertedAt: day(lead.convertedAt),
    }));

    return {
      dataScope: actor.ownOnly ? 'Chỉ lead giao cho người hỏi' : 'Mọi lead',
      from: from ?? null,
      to: to ?? null,
      total: list.total,
      byStatus,
      bySource,
      ...(byChannel ? { byChannel } : {}),
      leads,
      ...listMeta(leads.length, list.total),
    };
  },
};
