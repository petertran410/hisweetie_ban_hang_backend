import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import { LarkUserDirectoryService } from '../lark-sync/services/lark-user-directory.service';
import { SmaxApiService } from '../smax/smax-api.service';
import { SmaxChatService } from '../smax/smax-chat.service';
import { LeadLinkService } from './lead-link/lead-link.service';
import { normalizeVnPhone } from '../common/phone.util';
import {
  DEFAULT_LEAD_TEMPLATES,
  HANDOVER_STEPS,
  HandoverStep,
  isAcceptableStepError,
  ZALO_PHONE_NOT_FOUND,
  LEAD_CATEGORY_LABEL,
  leadCode,
  renderLeadTemplate,
  StepResult,
} from './leads.constants';
import {
  HandoverLeadDto,
  LeadConversationDto,
  LeadListQueryDto,
  LeadTemplatesDto,
  UpsertLeadDto,
} from './dto/lead.dto';

/** Người đang thao tác; ownOnly = chỉ có leads:view (Sale) → chỉ lead giao cho mình. */
export interface LeadActor {
  id: number;
  name: string;
  ownOnly: boolean;
}

type Steps = Record<HandoverStep, StepResult>;

const userBrief = { select: { id: true, name: true } } as const;
const ZALOWEB_TID = /^zlw(\d{3,25})$/;
// Phòng ban Lark của Sale nhận lead
const SALES_DEPARTMENT = 'Bộ Phận Sales';

/**
 * Lead: khách tiềm năng CSKH chăm sóc (chưa có đơn) rồi chuyển giao cho Sale PIC — báo Sale qua
 * Lark, kết bạn + gửi tin chào khách từ kênh Zalo cá nhân của Sale (qua Smax).
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly smaxApi: SmaxApiService,
    private readonly smaxChat: SmaxChatService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
    config: ConfigService,
    private readonly larkDirectory: LarkUserDirectoryService,
    private readonly leadLink: LeadLinkService,
  ) {
    this.frontendUrl = (
      config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/+$/, '');
  }

  // ───────────────────────────── danh sách / chi tiết ─────────────────────────────

  async list(q: LeadListQueryDto, actor: LeadActor) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 15));
    const csv = (v?: string) =>
      v
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
    const and: Prisma.LeadWhereInput[] = [];
    if (actor.ownOnly) and.push({ salePicId: actor.id });
    if (csv(q.sources).length) and.push({ source: { in: csv(q.sources) } });
    if (csv(q.categories).length)
      and.push({ category: { in: csv(q.categories) } });
    if (csv(q.statuses).length) and.push({ status: { in: csv(q.statuses) } });
    if (q.provinceCode) and.push({ provinceCode: q.provinceCode });
    if (q.salePicId) and.push({ salePicId: q.salePicId });
    if (q.linked)
      and.push({ customerId: q.linked === 'true' ? { not: null } : null });
    if (q.from) and.push({ createdAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ createdAt: { lte: new Date(q.to) } });
    const term = q.q?.trim();
    if (term) {
      const phone = term.replace(/\D/g, '');
      const code = term.match(/^lead0*(\d+)$/i); // mã LEAD000012
      and.push({
        OR: [
          ...(code ? [{ id: Number(code[1]) }] : []),
          { name: { contains: term, mode: 'insensitive' } },
          ...(!code && phone.length >= 3
            ? [{ phoneNormalized: { contains: phone.replace(/^84/, '0') } }]
            : []),
        ],
      });
    }
    const where: Prisma.LeadWhereInput = and.length ? { AND: and } : {};
    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          cskhUser: userBrief,
          salePic: userBrief,
          conversations: { select: { tid: true, pagePid: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);
    const customersOf = await this.linkedCustomers(data);
    const salePicOf = await this.customerSalePics(
      [...customersOf.values()].flat().map((c) => c.id),
    );
    return {
      data: data.map(({ conversations, ...l }) => ({
        ...this.withCustomerSalePic(l, customersOf.get(l.id), salePicOf),
        conversationCount: conversations.length,
        customers: customersOf.get(l.id) ?? [],
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Khách POS của lead: khách đã chuyển đổi (customerId) + khách đã gắn hội thoại của lead
   * (customer_zalo_contacts: Zalo cá nhân theo số Zalo, kênh khác theo tid + kênh).
   */
  private async linkedCustomers(
    leads: {
      id: number;
      customerId: number | null;
      conversations: { tid: string; pagePid: string }[];
    }[],
  ) {
    const zaloIdOf = (tid: string) => ZALOWEB_TID.exec(tid)?.[1] ?? tid;
    const ids = [
      ...new Set(
        leads.flatMap((l) => l.conversations.map((c) => zaloIdOf(c.tid))),
      ),
    ];
    const directIds = leads
      .map((l) => l.customerId)
      .filter((v): v is number => !!v);
    const brief = { id: true, code: true, name: true } as const;
    const [contacts, direct] = await Promise.all([
      ids.length
        ? this.prisma.customerZaloContact.findMany({
            where: { zaloId: { in: ids } },
            select: {
              zaloId: true,
              pagePid: true,
              customer: { select: brief },
            },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve(
            [] as {
              zaloId: string;
              pagePid: string | null;
              customer: { id: number; code: string | null; name: string };
            }[],
          ),
      directIds.length
        ? this.prisma.customer.findMany({
            where: { id: { in: directIds } },
            select: brief,
          })
        : Promise.resolve(
            [] as { id: number; code: string | null; name: string }[],
          ),
    ]);
    const out = new Map<
      number,
      { id: number; code: string | null; name: string }[]
    >();
    for (const l of leads) {
      const list = direct.filter((c) => c.id === l.customerId);
      for (const conv of l.conversations) {
        const zalo = ZALOWEB_TID.test(conv.tid);
        for (const ct of contacts) {
          const match = zalo
            ? ct.zaloId === zaloIdOf(conv.tid) && !ct.pagePid
            : ct.zaloId === conv.tid && ct.pagePid === conv.pagePid;
          if (match && !list.some((c) => c.id === ct.customer.id))
            list.push(ct.customer);
        }
      }
      if (list.length) out.set(l.id, list);
    }
    return out;
  }

  /** Sale PIC đã gán cho khách (chính sách công nợ): customerId → Sale. */
  private async customerSalePics(customerIds: number[]) {
    const policies = customerIds.length
      ? await this.prisma.customerDebtPolicy.findMany({
          where: { customerId: { in: customerIds }, salePicId: { not: null } },
          select: { customerId: true, salePicId: true },
        })
      : [];
    const users = policies.length
      ? await this.prisma.user.findMany({
          where: { id: { in: policies.map((p) => p.salePicId!) } },
          select: { id: true, name: true },
        })
      : [];
    const out = new Map<number, { id: number; name: string }>();
    for (const p of policies) {
      const u = users.find((x) => x.id === p.salePicId);
      if (u) out.set(p.customerId, u);
    }
    return out;
  }

  /** Lead chưa có Sale PIC mà đã gắn khách → lấy Sale PIC của khách (khách đầu tiên có Sale). */
  private withCustomerSalePic<
    T extends { salePicId: number | null; salePic: unknown },
  >(
    lead: T,
    customers: { id: number }[] | undefined,
    salePicOf: Map<number, { id: number; name: string }>,
  ) {
    if (lead.salePicId) return { ...lead, salePicFromCustomer: false };
    const sale = customers?.map((c) => salePicOf.get(c.id)).find((v) => !!v);
    return sale
      ? {
          ...lead,
          salePicId: sale.id,
          salePic: sale,
          salePicFromCustomer: true,
        }
      : { ...lead, salePicFromCustomer: false };
  }

  /** Lưu Sale PIC lấy từ khách đã gắn cho lead chưa có Sale (cron) → lọc / phân quyền theo Sale đúng. */
  async syncSalePicFromCustomers() {
    const leads = await this.prisma.lead.findMany({
      where: { salePicId: null, status: { not: 'cancelled' } },
      select: {
        id: true,
        name: true,
        createdById: true,
        customerId: true,
        conversations: { select: { tid: true, pagePid: true } },
      },
      take: 500,
    });
    const customersOf = await this.linkedCustomers(leads);
    const salePicOf = await this.customerSalePics(
      [...customersOf.values()].flat().map((c) => c.id),
    );
    let updated = 0;
    for (const l of leads) {
      const customer = customersOf.get(l.id)?.find((c) => salePicOf.has(c.id));
      if (!customer) continue;
      const sale = salePicOf.get(customer.id)!;
      await this.prisma.lead.update({
        where: { id: l.id },
        data: { salePicId: sale.id },
      });
      await this.audit(
        { id: l.createdById, name: 'Hệ thống' },
        'LEAD_UPDATE',
        l.id,
        `Tự động: Sale PIC lead "${l.name}" = ${sale.name} (theo khách ${customer.code ?? customer.name})`,
        { salePicId: sale.id, customerId: customer.id },
      );
      updated++;
    }
    return { checked: leads.length, updated };
  }

  async get(id: number, actor: LeadActor) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        cskhUser: userBrief,
        salePic: userBrief,
        conversations: { orderBy: { createdAt: 'asc' } },
        handovers: { orderBy: { createdAt: 'desc' } },
        formSubmissions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            answers: true,
            merged: true,
            createdAt: true,
            form: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!lead || (actor.ownOnly && lead.salePicId !== actor.id)) {
      throw new NotFoundException('Không tìm thấy lead');
    }
    const userIds = [
      ...new Set(lead.handovers.flatMap((h) => [h.salePicId, h.createdById])),
    ];
    const [users, linked] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve<{ id: number; name: string }[]>([]),
      this.linkedCustomers([lead]),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const customers = linked.get(lead.id) ?? [];
    // Chưa gắn khách → gợi ý (ID Zalo / hội thoại / SĐT, kèm SĐT Smax thu được trong hội thoại)
    const candidates = lead.customerId
      ? []
      : await this.leadLink.candidates(
          lead,
          await this.threadPhones(lead.conversations),
        );
    return {
      ...this.withCustomerSalePic(
        lead,
        customers,
        await this.customerSalePics(customers.map((c) => c.id)),
      ),
      customers,
      candidates,
      handovers: lead.handovers.map((h) => ({
        ...h,
        salePicName: nameOf.get(h.salePicId) ?? null,
        createdByName: nameOf.get(h.createdById) ?? null,
      })),
    };
  }

  // ───────────────────────────── tạo / sửa ─────────────────────────────

  async create(dto: UpsertLeadDto, actor: LeadActor) {
    if (!dto.name?.trim()) throw new BadRequestException('Nhập tên lead');
    if (!dto.source) throw new BadRequestException('Chọn nguồn');
    if (!dto.category) throw new BadRequestException('Chọn phân loại');
    const phone = dto.phone?.trim() || null;
    const lead = await this.prisma.lead.create({
      data: {
        ...this.fields(dto),
        // Tạo từ hội thoại Smax: kênh = kênh của hội thoại
        channelPid: dto.channelPid?.trim() || dto.conversation?.pagePid || null,
        name: dto.name.trim(),
        source: dto.source,
        category: dto.category,
        status: dto.status ?? 'new',
        phone,
        phoneNormalized: normalizeVnPhone(phone),
        zaloPhone: dto.zaloPhone?.trim() || phone,
        cskhUserId: dto.cskhUserId ?? actor.id,
        createdById: actor.id,
        ...(dto.conversation
          ? {
              conversations: {
                create: [this.conversationData(dto.conversation, actor.id)],
              },
            }
          : {}),
      },
    });
    await this.audit(actor, 'LEAD_CREATE', lead.id, `Tạo lead "${lead.name}"`, {
      lead,
    });
    return { lead, duplicates: await this.checkPhone(phone, lead.id) };
  }

  async update(id: number, dto: UpsertLeadDto, actor: LeadActor) {
    const before = await this.prisma.lead.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Không tìm thấy lead');
    const phone =
      dto.phone === undefined ? undefined : dto.phone.trim() || null;
    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        ...this.fields(dto),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.source ? { source: dto.source } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.cskhUserId !== undefined ? { cskhUserId: dto.cskhUserId } : {}),
        ...(phone !== undefined
          ? { phone, phoneNormalized: normalizeVnPhone(phone) }
          : {}),
        // Đổi SĐT Zalo → tra lại ID Zalo khi chuyển giao
        ...(dto.zaloPhone !== undefined
          ? { zaloPhone: dto.zaloPhone.trim() || null, zaloUid: null }
          : {}),
      },
    });
    await this.audit(actor, 'LEAD_UPDATE', id, `Sửa lead "${lead.name}"`, {
      before,
      after: lead,
    });
    return { lead, duplicates: await this.checkPhone(lead.phone, id) };
  }

  private fields(dto: UpsertLeadDto) {
    const opt = (v?: string) =>
      v === undefined ? undefined : v.trim() || null;
    return {
      channelPid: opt(dto.channelPid),
      channelName: opt(dto.channelName),
      provinceCode: opt(dto.provinceCode),
      provinceName: opt(dto.provinceName),
      wardCode: opt(dto.wardCode),
      wardName: opt(dto.wardName),
      need: opt(dto.need),
      cskhNote: opt(dto.cskhNote),
    };
  }

  /** Khách POS / lead khác trùng SĐT (đã chuẩn hoá) — cảnh báo, không chặn. */
  async checkPhone(phone?: string | null, excludeLeadId?: number) {
    const p = normalizeVnPhone(phone);
    if (!p) return { customers: [], leads: [] };
    const [customers, leads] = await Promise.all([
      this.prisma.customer.findMany({
        // SĐT khách có thể kèm hậu tố trùng (".1") → so đầu chuỗi
        where: {
          OR: [
            { contactNumber: { startsWith: p } },
            { phone: { startsWith: p } },
          ],
        },
        select: { id: true, code: true, name: true },
        take: 5,
      }),
      this.prisma.lead.findMany({
        where: {
          phoneNormalized: p,
          ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
        },
        select: { id: true, name: true, status: true },
        take: 5,
      }),
    ]);
    return { customers, leads };
  }

  // ───────────────────────────── kênh kết nối (hội thoại Smax) ─────────────────────────────

  async addConversation(
    id: number,
    dto: LeadConversationDto,
    actor: LeadActor,
  ) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Không tìm thấy lead');
    try {
      return await this.prisma.leadConversation.create({
        data: { leadId: id, ...this.conversationData(dto, actor.id) },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException('Hội thoại đã gắn với lead này');
      throw e;
    }
  }

  async removeConversation(id: number, conversationId: number) {
    const { count } = await this.prisma.leadConversation.deleteMany({
      where: { id: conversationId, leadId: id },
    });
    if (!count)
      throw new NotFoundException('Không tìm thấy hội thoại của lead');
    return { ok: true };
  }

  private conversationData(dto: LeadConversationDto, actorId: number) {
    if (!/^[a-z]{2,4}[A-Za-z0-9_-]{3,64}$/.test(dto.tid))
      throw new BadRequestException('Hội thoại không hợp lệ');
    return {
      pagePid: dto.pagePid,
      tid: dto.tid,
      platform: dto.platform,
      isGroup: !!dto.isGroup,
      name: dto.name?.trim() || null,
      createdById: actorId,
    };
  }

  // ───────────────────────────── thành khách hàng ─────────────────────────────

  /** Gắn lead với khách POS (gắn tay / vừa tạo khách từ lead). */
  convert(
    id: number,
    customerId: number,
    actor: LeadActor,
    method: 'manual' | 'created' = 'manual',
  ) {
    return this.leadLink.link(id, customerId, method, actor);
  }

  unlink(id: number, actor: LeadActor) {
    return this.leadLink.unlink(id, actor);
  }

  /** Cron: tự gắn lead với khách (ID Zalo / hội thoại / SĐT) + chuyển đổi khi khách có đơn đầu. */
  autoConvert() {
    return this.leadLink.sweep();
  }

  /** SĐT Smax thu được trong hội thoại của lead (tối đa 3 hội thoại; lỗi Smax → bỏ qua). */
  private async threadPhones(conversations: { pagePid: string; tid: string }[]) {
    const threads = await Promise.all(
      conversations
        .slice(0, 3)
        .map((c) =>
          this.smaxApi.getThread(c.pagePid, c.tid).catch(() => null),
        ),
    );
    return threads.flatMap((t) => t?.phones ?? []);
  }

  /**
   * Sale nhận lead: nhân sự đang làm thuộc phòng ban Lark "Bộ Phận Sales" (theo Lark ID).
   * Lark lỗi → mọi nhân sự (filtered: false) để không chặn chuyển giao.
   */
  async saleCandidates() {
    let openIds: Set<string> | null = null;
    try {
      openIds = await this.larkDirectory.openIdsInDepartments([
        SALES_DEPARTMENT,
      ]);
    } catch (e) {
      this.logger.warn(
        `Không đọc được phòng ban Lark "${SALES_DEPARTMENT}": ${(e as Error).message}`,
      );
    }
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(openIds ? { larkUserId: { in: [...openIds] } } : {}),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { users, filtered: !!openIds, department: SALES_DEPARTMENT };
  }

  /** Kênh (page) của biz trên Smax để chọn "Kênh" cho lead. */
  async channels() {
    const pages = await this.smaxApi.listPages();
    return pages.map((p) => ({
      pagePid: p.pid,
      name: p.name,
      platform: p.platform,
    }));
  }

  // ───────────────────────────── mẫu tin ─────────────────────────────

  async templates() {
    const s = await this.prisma.settings.findFirst();
    return {
      greeting: s?.leadGreetingTemplate || DEFAULT_LEAD_TEMPLATES.greeting,
      friend: s?.leadFriendTemplate || DEFAULT_LEAD_TEMPLATES.friend,
      lark: s?.leadLarkTemplate || DEFAULT_LEAD_TEMPLATES.lark,
      defaults: DEFAULT_LEAD_TEMPLATES,
    };
  }

  async saveTemplates(dto: LeadTemplatesDto, actor: LeadActor) {
    const s =
      (await this.prisma.settings.findFirst()) ??
      (await this.prisma.settings.create({ data: {} }));
    const val = (v?: string) =>
      v === undefined ? undefined : v.trim() || null;
    await this.prisma.settings.update({
      where: { id: s.id },
      data: {
        leadGreetingTemplate: val(dto.greeting),
        leadFriendTemplate: val(dto.friend),
        leadLarkTemplate: val(dto.lark),
      },
    });
    await this.audit(
      actor,
      'LEAD_TEMPLATES_UPDATE',
      null,
      'Sửa mẫu tin chuyển giao lead',
      { ...dto },
    );
    return this.templates();
  }

  // ───────────────────────────── chuyển giao cho Sale PIC ─────────────────────────────

  /**
   * Lý do chưa chuyển giao được (rỗng = được). Lead cần Zalo cá nhân của khách; Sale cần Lark ID
   * và ≥ 1 kênh Zalo cá nhân đã liên kết (còn trên Smax, không mất kết nối).
   */
  async handoverCheck(id: number, salePicId?: number, pagePid?: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: { conversations: true },
    });
    if (!lead) throw new NotFoundException('Không tìm thấy lead');
    const reasons: string[] = [];
    if (['converted', 'cancelled'].includes(lead.status))
      reasons.push('Lead đã chuyển đổi / đã huỷ');
    if (!this.leadZaloSource(lead))
      reasons.push('Lead chưa có SĐT Zalo cá nhân của khách');
    let channels: {
      pagePid: string;
      name: string;
      connectionError: boolean;
    }[] = [];
    if (salePicId) {
      const sale = await this.prisma.user.findUnique({
        where: { id: salePicId },
        select: { larkUserId: true, isActive: true },
      });
      if (!sale?.isActive) reasons.push('Sale PIC không tồn tại / đã ngừng');
      else if (!sale.larkUserId?.trim())
        reasons.push('Sale PIC chưa có Lark ID');
      channels = await this.saleZaloChannels(salePicId);
      if (!channels.length)
        reasons.push('Sale PIC chưa liên kết kênh Zalo cá nhân trên Smax');
      else if (pagePid) {
        const ch = channels.find((c) => c.pagePid === pagePid);
        if (!ch) reasons.push('Kênh Zalo không thuộc Sale PIC');
        else if (ch.connectionError)
          reasons.push(`Kênh "${ch.name}" đang mất kết nối`);
      }
    }
    return { ok: reasons.length === 0, reasons, channels };
  }

  /** Kênh Zalo cá nhân còn trên Smax đã liên kết với Sale. */
  private async saleZaloChannels(userId: number) {
    const channels = await this.smaxChat.myChannels(userId);
    return channels
      .filter((c) => !c.missing && c.platform === 'zaloweb')
      .map((c) => ({
        pagePid: c.pagePid,
        name: c.name,
        connectionError: !!c.connectionError,
      }));
  }

  /** ID Zalo đã biết (hội thoại Zalo cá nhân đã gắn / đã tra) hoặc SĐT Zalo để tra. */
  private leadZaloSource(lead: {
    zaloUid: string | null;
    zaloPhone: string | null;
    conversations: { tid: string; isGroup: boolean }[];
  }) {
    const conv = lead.conversations.find(
      (c) => !c.isGroup && ZALOWEB_TID.test(c.tid),
    );
    const uid = lead.zaloUid || (conv ? ZALOWEB_TID.exec(conv.tid)![1] : null);
    const phone = normalizeVnPhone(lead.zaloPhone);
    return uid || phone ? { uid, phone } : null;
  }

  async handover(id: number, dto: HandoverLeadDto, actor: LeadActor) {
    if (!dto.confirmed)
      throw new BadRequestException(
        'Cần xác nhận trước khi gửi tin chuyển giao',
      );
    const check = await this.handoverCheck(id, dto.salePicId, dto.pagePid);
    if (!check.ok) throw new BadRequestException(check.reasons.join('; '));
    const handover = await this.prisma.leadHandover.create({
      data: {
        leadId: id,
        salePicId: dto.salePicId,
        pagePid: dto.pagePid,
        note: dto.note?.trim() || null,
        larkText: dto.larkText.trim(),
        friendMessage: dto.friendMessage.trim(),
        greeting: dto.greeting.trim(),
        steps: Object.fromEntries(
          HANDOVER_STEPS.map((s) => [s, { status: 'pending' }]),
        ) as unknown as Prisma.InputJsonValue,
        status: 'partial',
        createdById: actor.id,
      },
    });
    return this.runHandover(handover.id, actor);
  }

  /** Gửi lại các bước lỗi của 1 lần chuyển giao (không gửi lại bước đã thành công). */
  async retryHandover(
    handoverId: number,
    confirmed: boolean | undefined,
    actor: LeadActor,
  ) {
    if (!confirmed)
      throw new BadRequestException('Cần xác nhận trước khi gửi lại');
    const h = await this.prisma.leadHandover.findUnique({
      where: { id: handoverId },
    });
    if (!h) throw new NotFoundException('Không tìm thấy lần chuyển giao');
    if (h.status === 'done')
      throw new BadRequestException('Lần chuyển giao này đã hoàn tất');
    return this.runHandover(handoverId, actor);
  }

  private async runHandover(handoverId: number, actor: LeadActor) {
    const h = await this.prisma.leadHandover.findUniqueOrThrow({
      where: { id: handoverId },
    });
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: h.leadId },
      include: { conversations: true },
    });
    const sale = await this.prisma.user.findUniqueOrThrow({
      where: { id: h.salePicId },
      select: { id: true, name: true, larkUserId: true },
    });
    const steps = h.steps as unknown as Steps;
    // Bước đã lỗi trước đây với lỗi nay được chấp nhận (vd "đã là bạn bè") → bỏ qua, không gửi lại
    for (const s of HANDOVER_STEPS) {
      if (steps[s]?.status === 'failed' && isAcceptableStepError(s, steps[s].error))
        steps[s] = { ...steps[s], status: 'skipped' };
    }
    // Mỗi lượt gửi tính vào giới hạn tần suất chung của người bấm
    this.smaxChat.assertSendRate(actor.id);

    const run = async (
      step: HandoverStep,
      fn: () => Promise<void>,
      label: string,
    ) => {
      if (steps[step]?.status === 'ok' || steps[step]?.status === 'skipped')
        return;
      try {
        await fn();
        steps[step] = { status: 'ok', at: new Date().toISOString() };
      } catch (e) {
        const error = (e as Error).message || 'Lỗi không xác định';
        steps[step] = {
          // Khách chặn tin người lạ / đã là bạn bè: vẫn hoàn tất chuyển giao
          status: isAcceptableStepError(step, error) ? 'skipped' : 'failed',
          at: new Date().toISOString(),
          error,
        };
      }
      const ok = steps[step].status === 'ok';
      const skipped = steps[step].status === 'skipped';
      await this.audit(
        actor,
        `LEAD_HANDOVER_${step.toUpperCase()}`,
        lead.id,
        `${label} cho lead "${lead.name}" → Sale ${sale.name}: ${ok ? 'thành công' : `${skipped ? 'bỏ qua' : 'lỗi'} — ${steps[step].error}`}`,
        {
          handoverId,
          step,
          status: steps[step].status,
          error: steps[step].error,
          pagePid: h.pagePid,
        },
      );
    };

    // 1. Báo Sale qua Lark
    await run(
      'lark',
      () => this.sendLark(sale.larkUserId, h.larkText),
      'Gửi Lark',
    );

    // 2. Kết bạn Zalo từ kênh của Sale (tra ID Zalo theo SĐT nếu chưa có)
    let uid: string | null = null;
    const zaloUid = async () => {
      if (uid) return uid;
      await this.smaxChat.userZaloChannel(sale.id, h.pagePid);
      const src = this.leadZaloSource(lead);
      if (!src) throw new Error('Lead chưa có SĐT Zalo cá nhân');
      uid = src.uid;
      if (!uid) {
        const found = await this.smaxApi.findFriendByPhone(
          h.pagePid,
          `84${src.phone!.slice(1)}`,
        );
        if (!found) throw new Error(`Không tìm thấy Zalo của SĐT ${src.phone}`);
        uid = found.uid;
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { zaloUid: uid },
        });
      }
      return uid;
    };
    await run(
      'friend',
      async () => {
        await this.smaxApi.requestFriend(
          h.pagePid,
          await zaloUid(),
          h.friendMessage,
        );
      },
      'Gửi lời mời kết bạn Zalo',
    );

    // 3. Tin chào từ Zalo của Sale
    await run(
      'greeting',
      async () => {
        await this.smaxApi.sendZaloweb(
          h.pagePid,
          { uid: await zaloUid() },
          { message: h.greeting },
        );
      },
      'Gửi tin chào Zalo',
    );

    return this.finishHandover(h, lead, steps, uid, actor);
  }

  /**
   * Không tìm thấy Zalo theo SĐT: người chuyển giao xác nhận SĐT khách là đúng → bước kết bạn
   * + tin chào coi như hoàn tất (Sale liên hệ khách qua SĐT), đủ điều kiện "Đã chuyển Sale".
   */
  async confirmHandoverPhone(
    handoverId: number,
    confirmed: boolean | undefined,
    actor: LeadActor,
  ) {
    if (!confirmed)
      throw new BadRequestException('Cần xác nhận SĐT khách là đúng');
    const h = await this.prisma.leadHandover.findUnique({
      where: { id: handoverId },
    });
    if (!h) throw new NotFoundException('Không tìm thấy lần chuyển giao');
    if (h.status === 'done')
      throw new BadRequestException('Lần chuyển giao này đã hoàn tất');
    const steps = h.steps as unknown as Steps;
    const targets = (['friend', 'greeting'] as const).filter(
      (s) =>
        steps[s]?.status === 'failed' &&
        ZALO_PHONE_NOT_FOUND.test(steps[s].error ?? ''),
    );
    if (!targets.includes('friend'))
      throw new BadRequestException(
        'Chỉ xác nhận SĐT khi bước kết bạn lỗi "Không tìm thấy Zalo"',
      );
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: h.leadId },
      include: { conversations: true },
    });
    const at = new Date().toISOString();
    for (const s of targets)
      steps[s] = { ...steps[s], status: 'skipped', at, confirmedBy: actor.name };
    await this.audit(
      actor,
      'LEAD_HANDOVER_PHONE_CONFIRMED',
      lead.id,
      `Xác nhận đúng SĐT khách (không tìm thấy Zalo) cho lead "${lead.name}"`,
      { handoverId, steps: targets, error: steps.friend.error },
    );
    return this.finishHandover(h, lead, steps, null, actor);
  }

  /** Lưu kết quả các bước; đủ bước → lead "Đã chuyển Sale" + gắn Sale PIC. */
  private async finishHandover(
    h: { id: number; pagePid: string; salePicId: number },
    lead: { id: number; name: string; customerId: number | null },
    steps: Steps,
    uid: string | null,
    actor: LeadActor,
  ) {
    const handoverId = h.id;
    const done = HANDOVER_STEPS.every(
      (s) => steps[s].status === 'ok' || steps[s].status === 'skipped',
    );
    const saved = await this.prisma.leadHandover.update({
      where: { id: handoverId },
      data: {
        steps: steps as unknown as Prisma.InputJsonValue,
        status: done ? 'done' : 'partial',
      },
    });
    // Hội thoại Zalo của Sale với khách → kênh kết nối của lead (mở chat, gắn khách theo ID Zalo)
    if (uid) {
      await this.prisma.leadConversation.upsert({
        where: { leadId_tid: { leadId: lead.id, tid: `zlw${uid}` } },
        create: {
          leadId: lead.id,
          pagePid: h.pagePid,
          tid: `zlw${uid}`,
          platform: 'zaloweb',
          isGroup: false,
          name: lead.name,
          createdById: actor.id,
        },
        update: {},
      });
    }
    if (done) {
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          // Đã gắn khách / chuyển đổi trước đó thì giữ trạng thái
          ...(lead.customerId ? {} : { status: 'handed_over' }),
          salePicId: h.salePicId,
        },
      });
      // Sale đã có khách POS cùng ID Zalo → gắn luôn
      await this.leadLink
        .autoLink(lead.id, actor)
        .catch((e) =>
          this.logger.warn(
            `Tự gắn lead ${lead.id} sau chuyển giao lỗi: ${(e as Error).message}`,
          ),
        );
    }
    return { handover: saved, done };
  }

  private async sendLark(larkUserId: string | null, text: string) {
    if (!larkUserId?.trim()) throw new Error('Sale PIC chưa có Lark ID');
    const res = await this.larkClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: larkUserId.trim(),
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (res?.code && res.code !== 0)
      throw new Error(`Lark ${res.code}: ${res.msg || 'lỗi không xác định'}`);
  }

  /** Nội dung xem trước (mẫu đã thay biến) cho modal chuyển giao. */
  async handoverPreview(id: number, salePicId: number, note?: string) {
    const [lead, sale, t] = await Promise.all([
      this.prisma.lead.findUnique({ where: { id } }),
      this.prisma.user.findUnique({
        where: { id: salePicId },
        select: { name: true },
      }),
      this.templates(),
    ]);
    if (!lead) throw new NotFoundException('Không tìm thấy lead');
    if (!sale) throw new ForbiddenException('Sale PIC không tồn tại');
    const vars = {
      'tên khách': lead.name,
      'tên sale': sale.name,
      sđt: lead.phone ?? '',
      'phân loại': LEAD_CATEGORY_LABEL[lead.category] ?? lead.category,
      'tỉnh thành': lead.provinceName ?? '',
      phường: lead.wardName ?? '',
      'nhu cầu': lead.need ?? '',
      'ghi chú': note?.trim() || lead.cskhNote || '',
      link: `${this.frontendUrl}/khach-hang/lead?Code=${leadCode(lead.id)}`,
    };
    return {
      larkText: renderLeadTemplate(t.lark, vars),
      friendMessage: renderLeadTemplate(t.friend, vars).slice(0, 150),
      greeting: renderLeadTemplate(t.greeting, vars),
    };
  }

  private audit(
    actor: { id: number; name: string },
    actionCode: string,
    leadId: number | null,
    message: string,
    metadata: unknown,
  ) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'leads',
      entityId: leadId === null ? undefined : String(leadId),
      message,
      userId: actor.id,
      userName: actor.name,
      metadata,
    });
  }
}
