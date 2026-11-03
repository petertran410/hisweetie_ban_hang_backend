import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { normalizeVnPhone } from '../../common/phone.util';
import { ORDER_STATUS } from '../../orders/dto/order-status.constants';
import { INVOICE_STATUS } from '../../invoices/dto/invoice-status.constants';
import { leadCode } from '../leads.constants';

/** Cách gắn lead ↔ khách; "unlinked" = người dùng đã gỡ → không tự gắn lại. */
export type LinkMethod = 'zalo' | 'conversation' | 'phone' | 'manual' | 'created';
export const UNLINKED = 'unlinked';
// Lý do gợi ý: 3 cách tự gắn + SĐT Smax thu được trong hội thoại của lead (chỉ gợi ý)
export type CandidateReason = 'zalo' | 'conversation' | 'phone' | 'thread_phone';

export interface LinkActor {
  id: number;
  name: string;
}

/** Người xem hành trình; ownOnly = Sale chỉ thấy lead giao cho mình. */
export interface JourneyViewer {
  canViewLeads: boolean;
  ownOnly: boolean;
  userId: number;
}

type Brief = { id: number; code: string | null; name: string };
export type LeadCandidate = Brief & { reason: CandidateReason; auto: boolean };

interface LeadKeys {
  id: number;
  zaloUid: string | null;
  phoneNormalized: string | null;
  zaloPhone: string | null;
  conversations: { tid: string; pagePid: string; isGroup: boolean }[];
}

const ZALOWEB_TID = /^zlw(\d{3,25})$/;
const brief = { id: true, code: true, name: true } as const;
const keysSelect = {
  id: true,
  zaloUid: true,
  phoneNormalized: true,
  zaloPhone: true,
  conversations: { select: { tid: true, pagePid: true, isGroup: true } },
} as const;

/**
 * Gắn lead ↔ khách POS và hành trình khách (lead → chuyển Sale → mã KH → đơn → hóa đơn).
 * Tách khỏi LeadsService để module Smax (gắn ID Zalo cho khách) gọi được mà không phụ thuộc vòng.
 */
@Injectable()
export class LeadLinkService {
  private readonly logger = new Logger(LeadLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ───────────────────────────── so khớp ─────────────────────────────

  /**
   * Khách khớp lead theo thứ tự: ID Zalo → hội thoại kênh khác → SĐT (+ SĐT trong hội thoại, chỉ gợi ý).
   * auto = quy tắc đầu tiên có khách ra đúng 1 khách (khớp ≥ 2 khách → chỉ gợi ý).
   */
  async candidates(lead: LeadKeys, threadPhones: string[] = []): Promise<LeadCandidate[]> {
    const uids = [
      ...new Set(
        [
          lead.zaloUid,
          ...lead.conversations
            .filter((c) => !c.isGroup)
            .map((c) => ZALOWEB_TID.exec(c.tid)?.[1]),
        ].filter((v): v is string => !!v),
      ),
    ];
    const others = lead.conversations.filter((c) => !ZALOWEB_TID.test(c.tid) && !c.isGroup);
    const phones = [
      ...new Set([lead.phoneNormalized, normalizeVnPhone(lead.zaloPhone)].filter((v): v is string => !!v)),
    ];
    const threadOnly = [
      ...new Set(threadPhones.map((p) => normalizeVnPhone(p)).filter((p): p is string => !!p && !phones.includes(p))),
    ];
    const byContact = (where: object) =>
      this.prisma.customerZaloContact
        .findMany({ where: { kind: 'user', ...where }, select: { customer: { select: brief } } })
        .then((rows) => rows.map((r) => r.customer));
    const byPhone = (list: string[]) =>
      list.length
        ? this.prisma.customer.findMany({
            // SĐT khách có thể kèm hậu tố trùng (".1") → so đầu chuỗi
            where: {
              OR: list.flatMap((p) => [{ contactNumber: { startsWith: p } }, { phone: { startsWith: p } }]),
            },
            select: brief,
            take: 5,
          })
        : Promise.resolve([] as Brief[]);
    const [zalo, conv, phone, thread] = await Promise.all([
      uids.length ? byContact({ zaloId: { in: uids }, pagePid: null }) : Promise.resolve([] as Brief[]),
      others.length
        ? byContact({ OR: others.map((c) => ({ zaloId: c.tid, pagePid: c.pagePid })) })
        : Promise.resolve([] as Brief[]),
      byPhone(phones),
      byPhone(threadOnly),
    ]);
    const out: LeadCandidate[] = [];
    let autoTaken = false;
    for (const [reason, list] of [
      ['zalo', zalo],
      ['conversation', conv],
      ['phone', phone],
      ['thread_phone', thread],
    ] as const) {
      const uniq = list.filter((c, i) => list.findIndex((x) => x.id === c.id) === i);
      const auto = !autoTaken && reason !== 'thread_phone' && uniq.length === 1;
      if (uniq.length && reason !== 'thread_phone') autoTaken = true;
      for (const c of uniq) if (!out.some((o) => o.id === c.id)) out.push({ ...c, reason, auto });
    }
    return out;
  }

  /** Tự gắn lead chưa gắn (chưa huỷ, chưa gỡ tay) nếu có khách khớp chắc chắn. */
  async autoLink(leadId: number, actor: LinkActor | null = null) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { ...keysSelect, customerId: true, status: true, linkMethod: true },
    });
    if (!lead || lead.customerId || lead.status === 'cancelled' || lead.linkMethod === UNLINKED) return null;
    const hit = (await this.candidates(lead)).find((c) => c.auto);
    if (!hit) return null;
    return this.link(leadId, hit.id, hit.reason as LinkMethod, actor);
  }

  /**
   * Khách vừa được gắn ID Zalo / hội thoại (sidechat) → lead chưa gắn có cùng ID Zalo
   * (đã tra khi chuyển giao) hoặc cùng hội thoại → tự gắn vào khách này.
   */
  async linkByContact(
    customerId: number,
    contact: { kind: string; zaloId: string; pagePid: string | null },
    actor: LinkActor,
  ) {
    if (contact.kind !== 'user') return null;
    const zalo = /^\d+$/.test(contact.zaloId) && !contact.pagePid;
    const leads = await this.prisma.lead.findMany({
      where: {
        customerId: null,
        status: { not: 'cancelled' },
        OR: [{ linkMethod: null }, { linkMethod: { not: UNLINKED } }],
        ...(zalo
          ? {
              AND: [
                {
                  OR: [
                    { zaloUid: contact.zaloId },
                    { conversations: { some: { tid: `zlw${contact.zaloId}`, isGroup: false } } },
                  ],
                },
              ],
            }
          : { conversations: { some: { tid: contact.zaloId, pagePid: contact.pagePid ?? undefined } } }),
      },
      select: { id: true },
      take: 2,
    });
    // Nhiều lead cùng 1 người → không đoán, để người dùng gắn tay
    if (leads.length !== 1) return null;
    await this.link(leads[0].id, customerId, zalo ? 'zalo' : 'conversation', actor);
    return { id: leads[0].id, code: leadCode(leads[0].id) };
  }

  // ───────────────────────────── gắn / gỡ ─────────────────────────────

  /** Gắn lead với khách: chép hội thoại của lead sang khách, lấy Sale PIC của khách, cập nhật chuyển đổi. */
  async link(id: number, customerId: number, method: LinkMethod, actor: LinkActor | null) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: { conversations: true },
    });
    if (!lead) throw new NotFoundException('Không tìm thấy lead');
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: brief,
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    // Quy ước customer_zalo_contacts: Zalo cá nhân lưu số Zalo; kênh khác lưu tid + page_pid
    const existing = await this.prisma.customerZaloContact.findMany({
      where: { customerId },
    });
    let copied = 0;
    for (const c of lead.conversations) {
      const zalo = ZALOWEB_TID.exec(c.tid);
      const data = zalo
        ? { kind: c.isGroup ? 'group' : 'user', zaloId: zalo[1], pagePid: null }
        : { kind: 'user', zaloId: c.tid, pagePid: c.pagePid };
      // Không ghi đè ID Zalo cá nhân / hội thoại cùng kênh khách đã có
      const taken = existing.some((e) =>
        data.kind === 'user'
          ? e.kind === 'user' && (zalo ? /^\d+$/.test(e.zaloId) : e.pagePid === c.pagePid)
          : e.kind === 'group' && e.zaloId === data.zaloId,
      );
      if (taken) continue;
      await this.prisma.customerZaloContact.create({
        data: {
          customerId,
          ...data,
          name: c.name,
          createdById: actor?.id ?? lead.createdById,
        },
      });
      copied++;
    }
    const sale = lead.salePicId ? undefined : (await this.customerSalePic(customerId)) ?? undefined;
    await this.prisma.lead.update({
      where: { id },
      data: {
        customerId,
        linkMethod: method,
        linkedAt: new Date(),
        linkedById: actor?.id ?? null,
        // Gắn lại khách khác: tính chuyển đổi lại theo khách mới
        ...(lead.status === 'converted'
          ? { status: this.baseStatus(sale?.id ?? lead.salePicId), convertedAt: null }
          : {}),
        ...(sale ? { salePicId: sale.id } : {}),
      },
    });
    await this.audit(
      // Tự gắn (cron / hệ thống): ghi dưới tên người tạo lead
      actor ?? { id: lead.createdById, name: 'Hệ thống (tự gắn)' },
      'LEAD_LINK',
      id,
      `${actor ? '' : 'Tự động: '}gắn lead "${lead.name}" với khách ${customer.code ?? customer.name} (${LINK_METHOD_LABEL[method]})`,
      { customerId, method, copiedConversations: copied },
    );
    const converted = await this.refreshConversion(id);
    return {
      lead: await this.prisma.lead.findUniqueOrThrow({ where: { id } }),
      customer,
      copiedConversations: copied,
      converted,
    };
  }

  /** Gỡ lead khỏi khách (gắn nhầm); hội thoại đã chép sang khách giữ nguyên. Không tự gắn lại. */
  async unlink(id: number, actor: LinkActor) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Không tìm thấy lead');
    if (!lead.customerId) return lead;
    const updated = await this.prisma.lead.update({
      where: { id },
      data: {
        customerId: null,
        linkMethod: UNLINKED,
        linkedAt: null,
        linkedById: null,
        convertedAt: null,
        ...(lead.status === 'converted' ? { status: this.baseStatus(lead.salePicId) } : {}),
      },
    });
    await this.audit(actor, 'LEAD_UNLINK', id, `Gỡ lead "${lead.name}" khỏi khách #${lead.customerId}`, {
      customerId: lead.customerId,
      method: lead.linkMethod,
    });
    return updated;
  }

  /**
   * Khách đã gắn có đơn đặt hàng đầu (không huỷ) tạo từ lúc có lead → "Đã chuyển đổi",
   * convertedAt = ngày tạo đơn. Khách cũ chỉ có đơn trước khi có lead → chưa tính chuyển đổi.
   */
  async refreshConversion(id: number) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, customerId: true, createdById: true, createdAt: true },
    });
    if (!lead?.customerId || lead.status === 'converted' || lead.status === 'cancelled') return false;
    const order = await this.prisma.order.findFirst({
      where: {
        customerId: lead.customerId,
        status: { not: ORDER_STATUS.CANCELLED },
        createdAt: { gte: lead.createdAt },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, createdAt: true },
    });
    if (!order) return false;
    await this.prisma.lead.update({
      where: { id },
      data: { status: 'converted', convertedAt: order.createdAt },
    });
    await this.audit(
      { id: lead.createdById, name: 'Hệ thống' },
      'LEAD_CONVERTED',
      id,
      `Lead "${lead.name}" chuyển đổi: đơn đầu ${order.code}`,
      { customerId: lead.customerId, orderId: order.id, orderCode: order.code },
    );
    return true;
  }

  /** Cron: tự gắn lead chưa gắn, rồi cập nhật chuyển đổi cho lead đã gắn chưa có đơn. */
  async sweep() {
    const unlinked = await this.prisma.lead.findMany({
      where: {
        customerId: null,
        status: { not: 'cancelled' },
        OR: [{ linkMethod: null }, { linkMethod: { not: UNLINKED } }],
      },
      select: { id: true },
      orderBy: { id: 'desc' },
      take: 500,
    });
    let linked = 0;
    for (const l of unlinked) {
      try {
        if (await this.autoLink(l.id)) linked++;
      } catch (e) {
        this.logger.warn(`Tự gắn lead ${l.id} lỗi: ${(e as Error).message}`);
      }
    }
    const pending = await this.prisma.lead.findMany({
      where: { customerId: { not: null }, status: { notIn: ['converted', 'cancelled'] } },
      select: { id: true },
      take: 500,
    });
    let converted = 0;
    for (const l of pending) if (await this.refreshConversion(l.id)) converted++;
    return { checked: unlinked.length, linked, converted };
  }

  // ───────────────────────────── hành trình ─────────────────────────────

  /** Lead của khách (cho thẻ "Thông tin POS" cạnh khung chat). */
  async leadOfCustomer(customerId: number, viewer: JourneyViewer) {
    if (!viewer.canViewLeads) return null;
    const lead = await this.prisma.lead.findFirst({
      where: { customerId, ...(viewer.ownOnly ? { salePicId: viewer.userId } : {}) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        source: true,
        channelName: true,
        status: true,
        linkMethod: true,
        createdAt: true,
        cskhUser: { select: { name: true } },
      },
    });
    return lead
      ? {
          id: lead.id,
          code: leadCode(lead.id),
          source: lead.source,
          channelName: lead.channelName,
          status: lead.status,
          linkMethod: lead.linkMethod,
          createdAt: lead.createdAt,
          cskhName: lead.cskhUser?.name ?? null,
        }
      : null;
  }

  /** Hành trình theo lead hoặc theo khách: mốc chính + dòng thời gian. */
  async journey(target: { leadId: number } | { customerId: number }, viewer: JourneyViewer) {
    const visible = viewer.ownOnly ? { salePicId: viewer.userId } : {};
    let lead: Awaited<ReturnType<LeadLinkService['findLead']>> = null;
    let otherLeads: { id: number; code: string }[] = [];
    let customerId: number | null;
    if ('leadId' in target) {
      if (!viewer.canViewLeads) throw new NotFoundException('Không tìm thấy lead');
      lead = await this.findLead({ id: target.leadId, ...visible });
      if (!lead) throw new NotFoundException('Không tìm thấy lead');
      customerId = lead.customerId;
    } else {
      customerId = target.customerId;
      if (viewer.canViewLeads) {
        const leads = await this.prisma.lead.findMany({
          where: { customerId, ...visible },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (leads.length) lead = await this.findLead({ id: leads[0].id });
        otherLeads = leads.slice(1).map((l) => ({ id: l.id, code: leadCode(l.id) }));
      }
    }

    const [customer, orders, invoices, audits] = await Promise.all([
      customerId
        ? this.prisma.customer.findUnique({
            where: { id: customerId },
            select: { id: true, code: true, name: true, createdAt: true },
          })
        : null,
      // Chưa gắn khách / không có lead → id 0 không khớp bản ghi nào
      this.prisma.order.findMany({
        where: { customerId: customerId ?? 0 },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, code: true, createdAt: true, status: true, grandTotal: true },
      }),
      this.prisma.invoice.findMany({
        where: { customerId: customerId ?? 0 },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, code: true, createdAt: true, status: true, grandTotal: true },
      }),
      this.prisma.auditLog.findMany({
        where: { entityType: 'leads', entityId: String(lead?.id ?? 0) },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { actionCode: true, message: true, userName: true, createdAt: true, metadata: true },
      }),
    ]);

    // Có lead: mốc đơn / hóa đơn đầu tính từ lúc tạo lead (khách cũ quay lại)
    const since = lead?.createdAt.getTime() ?? 0;
    const firstOrder = orders.find((o) => o.status !== ORDER_STATUS.CANCELLED && o.createdAt.getTime() >= since) ?? null;
    const firstInvoice =
      invoices.find((i) => i.status !== INVOICE_STATUS.CANCELLED && i.createdAt.getTime() >= since) ?? null;
    const handedOver = lead?.handovers.find((h) => h.status === 'done') ?? null;
    const milestones = [
      ...(lead ? [{ key: 'lead', label: 'Tạo lead', at: lead.createdAt, ref: leadCode(lead.id) }] : []),
      ...(lead ? [{ key: 'handover', label: 'Chuyển Sale', at: handedOver?.createdAt ?? null, ref: lead.salePic?.name ?? null }] : []),
      { key: 'customer', label: 'Mã KH', at: customer?.createdAt ?? null, ref: customer?.code ?? null },
      { key: 'order', label: 'Đặt hàng', at: firstOrder?.createdAt ?? null, ref: firstOrder?.code ?? null },
      { key: 'invoice', label: 'Hóa đơn', at: firstInvoice?.createdAt ?? null, ref: firstInvoice?.code ?? null },
    ].map((m) => ({ ...m, done: !!m.at }));

    type JourneyEvent = {
      at: Date;
      type: string;
      title: string;
      by?: string | null;
      status?: string | null;
      ref?: { kind: 'lead' | 'customer' | 'order' | 'invoice'; code: string } | null;
    };
    const events: JourneyEvent[] = [];
    if (lead) {
      events.push({
        at: lead.createdAt,
        type: 'lead',
        title: `Tạo lead ${leadCode(lead.id)}${lead.channelName ? ` · kênh ${lead.channelName}` : ''}`,
        by: lead.cskhUser?.name ?? null,
        ref: { kind: 'lead', code: leadCode(lead.id) },
      });
      for (const f of lead.formSubmissions) {
        events.push({
          at: f.createdAt,
          type: 'form',
          title: `Khách gửi form "${f.form?.name ?? ''}"${f.merged ? ' (gộp vào lead)' : ''}`,
        });
      }
      for (const a of audits) {
        if (a.actionCode === 'LEAD_CREATE') continue;
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        events.push({
          at: a.createdAt,
          type: JOURNEY_TYPE[a.actionCode] ?? 'update',
          title: a.message,
          by: a.userName,
          status: typeof meta.status === 'string' ? meta.status : null,
        });
      }
    }
    if (customer) {
      events.push({
        at: customer.createdAt,
        type: 'customer',
        title: `Tạo khách ${customer.code ?? ''} · ${customer.name}`,
        ref: customer.code ? { kind: 'customer', code: customer.code } : null,
      });
    }
    for (const o of orders) {
      events.push({
        at: o.createdAt,
        type: 'order',
        title: `Đơn đặt hàng ${o.code} · ${Number(o.grandTotal).toLocaleString('vi-VN')}đ`,
        status: o.status === ORDER_STATUS.CANCELLED ? 'cancelled' : null,
        ref: { kind: 'order', code: o.code },
      });
    }
    for (const i of invoices) {
      events.push({
        at: i.createdAt,
        type: 'invoice',
        title: `Hóa đơn ${i.code} · ${Number(i.grandTotal).toLocaleString('vi-VN')}đ`,
        status: i.status === INVOICE_STATUS.CANCELLED ? 'cancelled' : null,
        ref: { kind: 'invoice', code: i.code },
      });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      lead: lead
        ? {
            id: lead.id,
            code: leadCode(lead.id),
            name: lead.name,
            source: lead.source,
            channelName: lead.channelName,
            category: lead.category,
            status: lead.status,
            cskh: lead.cskhUser,
            salePic: lead.salePic,
            createdAt: lead.createdAt,
            linkMethod: lead.linkMethod,
            linkedAt: lead.linkedAt,
            convertedAt: lead.convertedAt,
          }
        : null,
      otherLeads,
      customer,
      milestones,
      events,
    };
  }

  private findLead(where: { id: number; salePicId?: number }) {
    return this.prisma.lead.findFirst({
      where,
      include: {
        cskhUser: { select: { id: true, name: true } },
        salePic: { select: { id: true, name: true } },
        handovers: { orderBy: { createdAt: 'asc' }, select: { status: true, createdAt: true } },
        formSubmissions: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, createdAt: true, merged: true, form: { select: { name: true } } },
        },
      },
    });
  }

  // ───────────────────────────── tiện ích ─────────────────────────────

  private baseStatus(salePicId: number | null) {
    return salePicId ? 'handed_over' : 'caring';
  }

  /** Sale PIC đã gán cho khách (chính sách công nợ). */
  private async customerSalePic(customerId: number) {
    const policy = await this.prisma.customerDebtPolicy.findFirst({
      where: { customerId, salePicId: { not: null } },
      select: { salePicId: true },
    });
    return policy?.salePicId
      ? this.prisma.user.findUnique({ where: { id: policy.salePicId }, select: { id: true, name: true } })
      : null;
  }

  private audit(actor: LinkActor, actionCode: string, leadId: number, message: string, metadata: unknown) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'leads',
      entityId: String(leadId),
      message,
      userId: actor.id,
      userName: actor.name,
      metadata,
    });
  }
}

export const LINK_METHOD_LABEL: Record<LinkMethod, string> = {
  zalo: 'trùng ID Zalo',
  conversation: 'trùng hội thoại',
  phone: 'trùng SĐT',
  manual: 'gắn tay',
  created: 'tạo khách từ lead',
};

// Mã audit → loại sự kiện trên dòng thời gian
const JOURNEY_TYPE: Record<string, string> = {
  LEAD_HANDOVER_LARK: 'handover',
  LEAD_HANDOVER_FRIEND: 'handover',
  LEAD_HANDOVER_GREETING: 'handover',
  LEAD_LINK: 'link',
  LEAD_UNLINK: 'link',
  LEAD_CONVERT: 'link',
  LEAD_AUTO_CONVERT: 'link',
  LEAD_CONVERTED: 'convert',
};
