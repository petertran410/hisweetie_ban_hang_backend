import {
  BadRequestException,
  HttpException,
  HttpStatus,
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
import { normalizeVnPhone } from '../common/phone.util';
import { slugifyVietnamese } from '../common/slug.util';
import {
  LEAD_CATEGORIES,
  LEAD_CATEGORY_LABEL,
  leadCode,
} from './leads.constants';
import {
  CUSTOM_FIELD_KEY,
  DEFAULT_LEAD_FORM_FIELDS,
  LEAD_FORM_BUILTIN_KEYS,
  LEAD_FORM_NO_DEFAULT_KEYS,
  LEAD_FORM_SLUG,
  LeadFormField,
  LeadFormProvince,
  SUBMIT_LIMIT_PER_IP,
  SUBMIT_LIMIT_PER_PHONE,
} from './lead-forms.constants';
import {
  LeadFormSubmissionsQueryDto,
  SubmitLeadFormDto,
  UpsertLeadFormDto,
} from './dto/lead-form.dto';

type Actor = { id: number; name: string };
type Answer = { key: string; label: string; value: string };
// Trường gửi lên khi tạo / sửa form (giá trị mặc định chưa kiểm)
type FieldInput = Omit<LeadFormField, 'defaultValue'> & { defaultValue?: unknown };

const DEFAULT_SUCCESS =
  'Cảm ơn bạn đã gửi thông tin! Chúng tôi sẽ liên hệ trong thời gian sớm nhất.';
const OPEN_LEAD = { notIn: ['converted', 'cancelled'] };

/**
 * Form công khai thu thập lead: CSKH tạo form (trường Lead + câu hỏi thêm, nguồn / kênh / CSKH
 * mặc định), chia sẻ link / iframe / QR. Khách gửi → tạo lead mới, hoặc gộp vào lead đang mở
 * trùng SĐT; báo Lark cho CSKH phụ trách. Chống spam: honeypot + giới hạn tần suất theo IP / SĐT.
 */
@Injectable()
export class LeadFormsService {
  private readonly logger = new Logger(LeadFormsService.name);
  private readonly frontendUrl: string;
  /** key giới hạn ("ip:…" / "phone:…") → mốc thời gian các lượt gửi gần đây */
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
    config: ConfigService,
  ) {
    this.frontendUrl = (
      config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
  }

  // ---------- Quản lý form (CSKH) ----------

  async list() {
    const forms = await this.prisma.leadForm.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { submissions: true } } },
    });
    const userIds = [
      ...new Set(
        forms.flatMap((f) => [f.cskhUserId, f.createdById]).filter(Boolean),
      ),
    ] as number[];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return forms.map(({ _count, ...f }) => ({
      ...f,
      submissionCount: _count.submissions,
      cskhUserName: f.cskhUserId ? (nameOf.get(f.cskhUserId) ?? null) : null,
      createdByName: nameOf.get(f.createdById) ?? null,
    }));
  }

  async create(dto: UpsertLeadFormDto, actor: Actor) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Nhập tên form');
    if (!dto.source) throw new BadRequestException('Chọn nguồn');
    const fields = this.normalizeFields(dto.fields ?? DEFAULT_LEAD_FORM_FIELDS);
    const category = dto.category || null;
    this.assertCategory(fields, category);
    const form = await this.prisma.leadForm.create({
      data: {
        name,
        slug: await this.uniqueSlug(dto.slug || slugifyVietnamese(name)),
        title: dto.title?.trim() || name,
        description: dto.description?.trim() || null,
        fields: fields as unknown as Prisma.InputJsonValue,
        source: dto.source,
        channelPid: dto.channelPid?.trim() || null,
        channelName: dto.channelName?.trim() || null,
        category,
        // null = không giao CSKH (không báo Lark); bỏ trống = người tạo
        cskhUserId: dto.cskhUserId === undefined ? actor.id : dto.cskhUserId,
        successMessage: dto.successMessage?.trim() || null,
        isActive: dto.isActive ?? true,
        createdById: actor.id,
      },
    });
    await this.audit(actor, 'LEAD_FORM_CREATE', form.id, `Tạo form "${name}"`, {
      form,
    });
    return form;
  }

  async update(id: number, dto: UpsertLeadFormDto, actor: Actor) {
    const before = await this.prisma.leadForm.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Không tìm thấy form');
    const fields = dto.fields
      ? this.normalizeFields(dto.fields)
      : (before.fields as unknown as LeadFormField[]);
    const category =
      dto.category === undefined ? before.category : dto.category || null;
    this.assertCategory(fields, category);
    const opt = (v?: string) =>
      v === undefined ? undefined : v.trim() || null;
    if (dto.name !== undefined && !dto.name.trim())
      throw new BadRequestException('Nhập tên form');
    const form = await this.prisma.leadForm.update({
      where: { id },
      data: {
        name: dto.name?.trim() || undefined,
        slug:
          dto.slug && dto.slug !== before.slug
            ? await this.uniqueSlug(dto.slug, id)
            : undefined,
        title:
          dto.title === undefined ? undefined : dto.title.trim() || before.name,
        description: opt(dto.description),
        fields: fields as unknown as Prisma.InputJsonValue,
        source: dto.source,
        channelPid: opt(dto.channelPid),
        channelName: opt(dto.channelName),
        category,
        cskhUserId: dto.cskhUserId,
        successMessage: opt(dto.successMessage),
        isActive: dto.isActive,
      },
    });
    await this.audit(actor, 'LEAD_FORM_UPDATE', id, `Sửa form "${form.name}"`, {
      before,
      after: form,
    });
    return form;
  }

  async remove(id: number, actor: Actor) {
    const form = await this.prisma.leadForm.findUnique({
      where: { id },
      include: { _count: { select: { submissions: true } } },
    });
    if (!form) throw new NotFoundException('Không tìm thấy form');
    if (form._count.submissions)
      throw new BadRequestException(
        'Form đã có lượt gửi — hãy tắt form thay vì xoá',
      );
    await this.prisma.leadForm.delete({ where: { id } });
    await this.audit(actor, 'LEAD_FORM_DELETE', id, `Xoá form "${form.name}"`, {
      form,
    });
    return { ok: true };
  }

  async submissions(id: number, q: LeadFormSubmissionsQueryDto) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const [data, total] = await Promise.all([
      this.prisma.leadFormSubmission.findMany({
        where: { formId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          answers: true,
          merged: true,
          createdAt: true,
          lead: { select: { id: true, name: true, status: true } },
        },
      }),
      this.prisma.leadFormSubmission.count({ where: { formId: id } }),
    ]);
    return { data, total, page, limit };
  }

  // ---------- Form công khai ----------

  async publicGet(slug: string) {
    const form = await this.activeForm(slug);
    return {
      slug: form.slug,
      title: form.title,
      description: form.description,
      fields: (form.fields as unknown as LeadFormField[])
        .filter((f) => f.enabled && !f.hidden)
        .map(({ key, label, required, type, options, defaultValue }) => ({
          key,
          label,
          required,
          type,
          options,
          defaultValue,
        })),
    };
  }

  async submit(
    slug: string,
    dto: SubmitLeadFormDto,
    meta: { ip?: string; userAgent?: string },
  ) {
    const form = await this.activeForm(slug);
    const message = form.successMessage || DEFAULT_SUCCESS;
    // Bot điền ô ẩn → báo thành công giả, không lưu
    if (dto.website?.trim()) return { ok: true, message };
    this.hit(`ip:${meta.ip ?? '?'}`, SUBMIT_LIMIT_PER_IP);

    const fields = (form.fields as unknown as LeadFormField[]).filter(
      (f) => f.enabled,
    );
    // Trường ẩn: luôn lấy giá trị mặc định (bỏ qua giá trị khách gửi lên)
    const raw: Record<string, unknown> = { ...(dto.answers ?? {}) };
    for (const f of fields) if (f.hidden) raw[f.key] = f.defaultValue;
    const v = this.parseAnswers(fields, raw);
    if (v.phoneNormalized)
      this.hit(`phone:${v.phoneNormalized}`, SUBMIT_LIMIT_PER_PHONE);

    const existing = v.phoneNormalized
      ? await this.prisma.lead.findFirst({
          where: { phoneNormalized: v.phoneNormalized, status: OPEN_LEAD },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const actor = { id: form.createdById, name: `Form "${form.name}"` };
    const submission = {
      formId: form.id,
      answers: v.answers as unknown as Prisma.InputJsonValue,
      ip: meta.ip?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    };

    let lead: { id: number; name: string; cskhUserId: number | null };
    if (existing) {
      // Gộp: chỉ điền trường lead đang trống, không ghi đè thông tin CSKH đã chỉnh
      lead = await this.prisma.lead.update({
        where: { id: existing.id },
        data: {
          zaloPhone: existing.zaloPhone ?? v.zaloPhone,
          ...(existing.provinceCode ? {} : v.province),
          need: existing.need || v.need,
          formSubmissions: { create: { ...submission, merged: true } },
        },
      });
      await this.audit(
        actor,
        'LEAD_MERGE_FROM_FORM',
        lead.id,
        `Khách gửi lại form "${form.name}" — gộp vào lead "${lead.name}"`,
        { formId: form.id, answers: v.answers },
      );
    } else {
      lead = await this.prisma.lead.create({
        data: {
          name: v.name,
          phone: v.phone,
          phoneNormalized: v.phoneNormalized,
          zaloPhone: v.zaloPhone ?? v.phone,
          source: form.source,
          channelPid: form.channelPid,
          channelName: form.channelName,
          category: v.category ?? form.category!,
          ...v.province,
          need: v.need,
          status: 'new',
          cskhUserId: form.cskhUserId,
          createdById: form.createdById,
          formSubmissions: { create: submission },
        },
      });
      await this.audit(
        actor,
        'LEAD_CREATE_FROM_FORM',
        lead.id,
        `Tạo lead "${lead.name}" từ form "${form.name}"`,
        { formId: form.id, answers: v.answers },
      );
    }

    await this.notifyCskh(
      lead.cskhUserId ?? form.cskhUserId,
      [
        `📝 ${existing ? 'Khách gửi lại' : 'Lead mới từ'} form "${form.name}"`,
        ...v.answers.map((a) => `${a.label}: ${a.value}`),
        `${this.frontendUrl}/khach-hang/lead?Code=${leadCode(lead.id)}`,
      ].join('\n'),
    );
    return { ok: true, message };
  }

  // ---------- Nội bộ ----------

  private async activeForm(slug: string) {
    const form = LEAD_FORM_SLUG.test(slug)
      ? await this.prisma.leadForm.findUnique({ where: { slug } })
      : null;
    if (!form?.isActive)
      throw new NotFoundException('Form không tồn tại hoặc đã đóng');
    return form;
  }

  /** Giữ thứ tự người dùng sắp; đủ mọi trường Lead; Họ tên luôn bật + bắt buộc. */
  private normalizeFields(input: FieldInput[]): LeadFormField[] {
    const seen = new Set<string>();
    const out: LeadFormField[] = [];
    for (const f of input) {
      const builtin = (LEAD_FORM_BUILTIN_KEYS as readonly string[]).includes(
        f.key,
      );
      if (!builtin && !CUSTOM_FIELD_KEY.test(f.key))
        throw new BadRequestException(`Trường không hợp lệ: ${f.key}`);
      if (seen.has(f.key))
        throw new BadRequestException(`Trường bị trùng: ${f.key}`);
      seen.add(f.key);
      const label =
        f.label?.trim() ||
        DEFAULT_LEAD_FORM_FIELDS.find((d) => d.key === f.key)?.label;
      if (!label) throw new BadRequestException('Câu hỏi thêm cần có nội dung');
      if (builtin) {
        const always = f.key === 'name';
        const enabled = always || !!f.enabled;
        out.push(
          this.withDefault(
            {
              key: f.key,
              label,
              enabled,
              required: always || (enabled && !!f.required),
            },
            f,
          ),
        );
        continue;
      }
      const type = f.type ?? 'text';
      const options = [
        ...new Set((f.options ?? []).map((o) => o.trim()).filter(Boolean)),
      ];
      if ((type === 'select' || type === 'multiselect') && !options.length)
        throw new BadRequestException(
          `Câu hỏi "${label}" cần ít nhất 1 lựa chọn`,
        );
      out.push(
        this.withDefault(
          {
            key: f.key,
            label,
            enabled: true,
            required: !!f.required,
            type,
            ...(options.length && type !== 'text' && type !== 'textarea'
              ? { options }
              : {}),
          },
          f,
        ),
      );
    }
    for (const d of DEFAULT_LEAD_FORM_FIELDS)
      if (!seen.has(d.key))
        out.push({
          ...d,
          enabled: d.key === 'name',
          required: d.key === 'name',
        });
    return out;
  }

  /** Lead bắt buộc có phân loại: form không hỏi bắt buộc → cần phân loại mặc định. */
  private assertCategory(fields: LeadFormField[], category: string | null) {
    const f = fields.find((x) => x.key === 'category');
    const fromForm = f?.enabled && (f.hidden ? !!f.defaultValue : f.required);
    if (!fromForm && !category)
      throw new BadRequestException(
        'Trường phân loại lead cần bật bắt buộc, hoặc ẩn kèm giá trị mặc định',
      );
  }

  /**
   * Giá trị mặc định + ẩn của 1 trường đang bật (Họ tên, SĐT: không có). Trường ẩn: không bắt buộc
   * (lead tự nhận giá trị mặc định) nên phải có giá trị mặc định.
   */
  private withDefault(field: LeadFormField, input: FieldInput): LeadFormField {
    if (!field.enabled || LEAD_FORM_NO_DEFAULT_KEYS.includes(field.key))
      return field;
    const defaultValue = this.cleanDefault(field, input.defaultValue);
    const hidden = !!input.hidden;
    if (hidden && defaultValue === undefined)
      throw new BadRequestException(
        `Trường ẩn "${field.label}" cần giá trị mặc định`,
      );
    return {
      ...field,
      ...(hidden ? { hidden, required: false } : {}),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  }

  /** Chuẩn hoá giá trị mặc định theo loại trường; rỗng → undefined, sai → 400. */
  private cleanDefault(
    f: LeadFormField,
    value: unknown,
  ): LeadFormField['defaultValue'] {
    const bad = () =>
      new BadRequestException(`Giá trị mặc định của "${f.label}" không hợp lệ`);
    if (value === undefined || value === null || value === '') return undefined;
    if (f.key === 'province') {
      if (typeof value !== 'object' || Array.isArray(value)) throw bad();
      const p = value as Record<string, unknown>;
      const s = (k: string, max: number) =>
        typeof p[k] === 'string' ? (p[k] as string).trim().slice(0, max) : '';
      const provinceCode = s('provinceCode', 20);
      if (!provinceCode) return undefined;
      const wardCode = s('wardCode', 20);
      const out: LeadFormProvince = {
        provinceCode,
        provinceName: s('provinceName', 255) || null,
        wardCode: wardCode || null,
        wardName: wardCode ? s('wardName', 255) || null : null,
      };
      return out;
    }
    if (f.type === 'multiselect') {
      if (!Array.isArray(value)) throw bad();
      const picked = (f.options ?? []).filter((o) => value.includes(o));
      if (picked.length !== value.length) throw bad();
      return picked.length ? picked : undefined;
    }
    if (typeof value !== 'string') throw bad();
    const v = value.trim().slice(0, f.type === 'textarea' || f.key === 'need' ? 2000 : 255);
    if (!v) return undefined;
    if (f.key === 'category' && !(LEAD_CATEGORIES as readonly string[]).includes(v))
      throw bad();
    if (f.key === 'zaloPhone' && !normalizeVnPhone(v)) throw bad();
    if (f.type === 'select' && !(f.options ?? []).includes(v)) throw bad();
    return v;
  }

  private async uniqueSlug(raw: string, excludeId?: number) {
    const base = slugifyVietnamese(raw).slice(0, 50).replace(/-+$/, '');
    if (!LEAD_FORM_SLUG.test(base))
      throw new BadRequestException('Đường dẫn form không hợp lệ');
    for (let i = 1; i < 100; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      const taken = await this.prisma.leadForm.findUnique({ where: { slug } });
      if (!taken || taken.id === excludeId) return slug;
    }
    throw new BadRequestException('Không tạo được đường dẫn form');
  }

  private parseAnswers(fields: LeadFormField[], raw: Record<string, unknown>) {
    const str = (key: string, max: number) =>
      typeof raw[key] === 'string'
        ? (raw[key] as string).trim().slice(0, max)
        : '';
    const answers: Answer[] = [];
    const missing = (f: LeadFormField) =>
      new BadRequestException(`Vui lòng nhập "${f.label}"`);
    const out: {
      name: string;
      phone: string | null;
      phoneNormalized: string | null;
      zaloPhone: string | null;
      category: string | null;
      need: string | null;
      province: Record<string, string | null>;
      answers: Answer[];
    } = {
      name: '',
      phone: null,
      phoneNormalized: null,
      zaloPhone: null,
      category: null,
      need: null,
      province: {},
      answers,
    };

    for (const f of fields) {
      let value = '';
      switch (f.key) {
        case 'phone':
        case 'zaloPhone': {
          const p = str(f.key, 40);
          if (p && !normalizeVnPhone(p))
            throw new BadRequestException(`"${f.label}" không hợp lệ`);
          if (f.key === 'phone') {
            out.phone = p || null;
            out.phoneNormalized = normalizeVnPhone(p);
          } else out.zaloPhone = p || null;
          value = p;
          break;
        }
        case 'category': {
          const c = str(f.key, 40);
          if (c && !(LEAD_CATEGORIES as readonly string[]).includes(c))
            throw new BadRequestException(`"${f.label}" không hợp lệ`);
          out.category = c || null;
          value = c ? LEAD_CATEGORY_LABEL[c] : '';
          break;
        }
        case 'province': {
          const p = (raw.province ?? {}) as Record<string, unknown>;
          const s = (k: string, max: number) =>
            typeof p[k] === 'string'
              ? (p[k] as string).trim().slice(0, max)
              : '';
          const provinceCode = s('provinceCode', 20);
          const provinceName = provinceCode ? s('provinceName', 255) : '';
          const wardCode = provinceCode ? s('wardCode', 20) : '';
          const wardName = wardCode ? s('wardName', 255) : '';
          if (provinceCode)
            out.province = {
              provinceCode,
              provinceName: provinceName || null,
              wardCode: wardCode || null,
              wardName: wardName || null,
            };
          value = [wardName, provinceName].filter(Boolean).join(', ');
          break;
        }
        default: {
          if (f.type === 'multiselect') {
            const list = Array.isArray(raw[f.key])
              ? (raw[f.key] as unknown[])
              : [];
            const picked = f.options!.filter((o) => list.includes(o));
            value = picked.join(', ');
          } else {
            value = str(
              f.key,
              f.type === 'textarea' || f.key === 'need' ? 2000 : 255,
            );
            if (f.type === 'select' && value && !f.options!.includes(value))
              throw new BadRequestException(`"${f.label}" không hợp lệ`);
          }
          if (f.key === 'name') out.name = value;
          if (f.key === 'need') out.need = value || null;
        }
      }
      if (f.required && !value) throw missing(f);
      if (value) answers.push({ key: f.key, label: f.label, value });
    }
    return out;
  }

  private hit(key: string, limit: { max: number; windowMs: number }) {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => now - t < limit.windowMs,
    );
    if (recent.length >= limit.max)
      throw new HttpException(
        'Bạn đã gửi quá nhiều lần, vui lòng thử lại sau ít phút',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    recent.push(now);
    this.hits.set(key, recent);
    // Dọn key cũ để Map không phình
    if (this.hits.size > 5000)
      for (const [k, ts] of this.hits)
        if (!ts.some((t) => now - t < SUBMIT_LIMIT_PER_PHONE.windowMs))
          this.hits.delete(k);
  }

  private async notifyCskh(userId: number | null, text: string) {
    if (!userId) return;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { larkUserId: true },
      });
      if (!user?.larkUserId) return;
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: user.larkUserId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.code) throw new Error(`Lark ${res.code}: ${res.msg}`);
    } catch (e) {
      this.logger.warn(
        `Không báo được Lark cho CSKH #${userId}: ${(e as Error).message}`,
      );
    }
  }

  private audit(
    actor: Actor,
    actionCode: string,
    entityId: number,
    message: string,
    metadata: unknown,
  ) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      // Lượt khách gửi form ghi vào lead; còn lại là thao tác trên form
      entityType: actionCode.startsWith('LEAD_FORM_') ? 'lead_forms' : 'leads',
      entityId: String(entityId),
      message,
      userId: actor.id,
      userName: actor.name,
      metadata,
    });
  }
}
