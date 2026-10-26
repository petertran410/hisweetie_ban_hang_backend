import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UploadService } from '../upload/upload.service';
import { repairUploadedFilename } from '../common/uploaded-filename.util';
import {
  GROUP_SCAN_LIMIT,
  SmaxApiService,
  SmaxGroupThread,
  SmaxPage,
  SmaxRawMessage,
  SmaxRecentThread,
  ZalowebContent,
} from './smax-api.service';

/** Người dùng đang gọi (rút gọn từ req.user). */
export interface ChatActor {
  id: number;
  name: string;
  canViewOtherStaffData?: boolean;
  canViewDebt: boolean;
}

export interface ChatMessage {
  id: string;
  text: string;
  type: string;
  fromMe: boolean;
  // pid người gửi ("zlw" + uid) — client tra tên/avatar trong `senders`
  senderPid: string | null;
  senderName: string | null;
  attachments: { url: string; thumbnail: string | null; title: string; type: string }[];
  // Mã album Zalo (group_layout_id) — client gom các tin cùng mã thành 1 album
  albumId: string | null;
  // Tin sticker Zalo
  stickerId: string | null;
  createdAt: string;
}

const SEND_LIMIT_PER_MINUTE = 20;
const GROUP_INDEX_TTL_MS = 10 * 60_000;
const RECENT_TTL_MS = 30_000;
// Mã khách POS trong tên nhóm Zalo, vd "… DIỆP TRÀ KH005844", "KH241166031.1"
const CUSTOMER_CODE_IN_NAME = /\bKH\d{3,}(?:\.\d+)?\b/gi;
const MEDIA_SUBFOLDER = 'smax-chat';
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']);
const FILE_MIMES = new Set([
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
]);

// Chỉ nhận ảnh VietQR do getPaymentInfo tạo (img.vietqr.io)
const VIETQR_URL = /^https:\/\/img\.vietqr\.io\/image\/[\w%.-]+-compact1\.png(\?[\w%=&.+-]*)?$/;

export type AttachmentKind = 'image' | 'video' | 'file';
export interface ChatAttachmentInput {
  // Đường dẫn trong /uploads do uploadAttachments trả về, vd "smax-chat/123-ab.jpg"
  path: string;
  kind: AttachmentKind;
  name: string;
}
// Kênh Zalo cá nhân: tid / pid hội thoại = "zlw" + ID Zalo (đã kiểm chứng 26/10).
const ZALOWEB_PREFIX = 'zlw';

/**
 * Sidebar chat Zalo trên POS: chat bằng kênh Zalo đã liên kết với CHÍNH người
 * dùng đang gọi (/cai-dat/smax) — không phụ thuộc Sale PIC.
 */
@Injectable()
export class SmaxChatService {
  private readonly sendLog = new Map<number, number[]>();
  // Chỉ mục nhóm theo kênh (quét Smax ~15s) — dùng chung giữa các khách
  private readonly recentCache = new Map<string, { at: number; threads: Promise<SmaxRecentThread[]> }>();
  private readonly groupIndex = new Map<
    string,
    { at: number; groups: Promise<SmaxGroupThread[]> }
  >();
  private readonly confirmBeforeSend: boolean;
  // Domain công khai Smax tải được file đính kèm (localhost thì Smax không tới được)
  private readonly mediaPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
    private readonly auditLogs: AuditLogsService,
    private readonly uploads: UploadService,
    config: ConfigService,
  ) {
    const base = config.get<string>('SMAX_MEDIA_PUBLIC_URL')?.trim().replace(/\/+$/, '');
    this.mediaPublicUrl = base && /^https:\/\//.test(base) ? base : null;
    const flag = config.get<string>('SMAX_CHAT_CONFIRM_SEND');
    this.confirmBeforeSend =
      flag !== undefined
        ? flag === 'true'
        : config.get<string>('NODE_ENV') !== 'production';
  }

  /** Kênh Zalo của người dùng, kèm tình trạng trên Smax. */
  async myChannels(userId: number) {
    const links = await this.prisma.smaxChannelUser.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!links.length) return [];
    const pages = await this.smaxApi.listPages();
    const byPid = new Map(pages.map((p) => [p.pid, p]));
    return links.map((l) => {
      const page = byPid.get(l.pagePid);
      return {
        pagePid: l.pagePid,
        name: page?.name ?? l.pageName,
        avatar: page?.picture ?? null,
        platform: page?.platform ?? l.platform,
        connectionError: page?.connectionError ?? null,
        missing: !page,
      };
    });
  }

  async getContext(customerId: number, actor: ChatActor) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        phone: true,
        totalDebt: true,
        debtPolicy: { select: { salePicId: true } },
        zaloContacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!customer) throw new NotFoundException('Khách hàng không tồn tại');

    const salePicId = customer.debtPolicy?.salePicId ?? null;
    const ownOnly = actor.canViewOtherStaffData === false;
    const [salePic, channels, orders, invoices] = await Promise.all([
      salePicId
        ? this.prisma.user.findUnique({
            where: { id: salePicId },
            select: { id: true, name: true },
          })
        : null,
      this.myChannels(actor.id),
      this.prisma.order.findMany({
        where: { customerId, ...(ownOnly ? { createdBy: actor.id } : {}) },
        orderBy: { orderDate: 'desc' },
        take: 5,
        select: {
          id: true,
          code: true,
          orderDate: true,
          grandTotal: true,
          statusValue: true,
          orderStatus: true,
        },
      }),
      this.prisma.invoice.findMany({
        where: { customerId, ...(ownOnly ? { createdBy: actor.id } : {}) },
        orderBy: { purchaseDate: 'desc' },
        take: 5,
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          grandTotal: true,
          debtAmount: true,
          statusValue: true,
        },
      }),
    ]);

    const contacts = customer.zaloContacts;
    return {
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.contactNumber || customer.phone || null,
      },
      salePic,
      myChannels: channels,
      contacts: {
        user: contacts.find((c) => c.kind === 'user') ?? null,
        groups: contacts.filter((c) => c.kind === 'group'),
      },
      debt: actor.canViewDebt ? Number(customer.totalDebt) : null,
      recentOrders: orders.map((o) => ({
        id: o.id,
        code: o.code,
        date: o.orderDate,
        total: Number(o.grandTotal),
        status: o.statusValue || o.orderStatus,
      })),
      recentInvoices: invoices.map((i) => ({
        id: i.id,
        code: i.code,
        date: i.purchaseDate,
        total: Number(i.grandTotal),
        debt: Number(i.debtAmount),
        status: i.statusValue,
      })),
      confirmBeforeSend: this.confirmBeforeSend,
    };
  }

  async getMessages(
    customerId: number,
    actor: ChatActor,
    pagePid: string,
    contactId: number,
    before?: string,
  ) {
    const channel = await this.assertOwnChannel(actor.id, pagePid);
    const contact = await this.getContact(customerId, contactId);
    const tid = `${ZALOWEB_PREFIX}${contact.zaloId}`;
    const [thread, raw] = await Promise.all([
      // Thông tin thread chỉ để lấy tên người gửi — Smax lỗi ở đây (đã gặp 500)
      // thì vẫn trả tin nhắn
      before ? null : this.smaxApi.getThread(channel.pid, tid).catch(() => null),
      this.smaxApi.getMessages(channel.pid, tid, before),
    ]);
    const members = thread?.members ?? {};
    // Người gửi khác kênh: tên + avatar (tin cũ tải thêm dùng lại bảng này ở client)
    const senders: Record<string, { name: string | null; avatar: string | null }> = {};
    for (const pid of new Set([...Object.keys(members), ...Object.keys(thread?.memberAvatars ?? {})])) {
      if (pid === channel.pid) continue;
      senders[pid] = { name: members[pid] ?? null, avatar: thread?.memberAvatars?.[pid] ?? null };
    }
    return {
      thread: thread ? { name: thread.name, chatType: thread.chatType } : null,
      senders,
      messages: this.normalize(raw, channel.pid, members),
      hasMore: raw.length >= 20,
    };
  }

  /** Lưu file đính kèm sẽ gửi qua Zalo; ảnh được nén/đổi HEIC → JPEG như upload chung. */
  async uploadAttachments(files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('Chưa chọn tệp');
    if (files.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`Tối đa ${MAX_ATTACHMENTS} tệp mỗi lần gửi`);
    }
    return Promise.all(
      files.map(async (f) => {
        // multer đọc tên tệp UTF-8 theo latin1 → "HoÌÌng TraÌ…"
        const originalName = repairUploadedFilename(f.originalname);
        const mime = f.mimetype.toLowerCase();
        const kind: AttachmentKind | null = IMAGE_MIMES.has(mime)
          ? 'image'
          : VIDEO_MIMES.has(mime)
            ? 'video'
            : FILE_MIMES.has(mime)
              ? 'file'
              : null;
        if (!kind) {
          throw new BadRequestException(`Không hỗ trợ loại tệp "${originalName}"`);
        }
        if (f.size > MAX_ATTACHMENT_BYTES) {
          throw new BadRequestException(`"${originalName}" vượt quá 25MB`);
        }
        if (kind === 'image') {
          const saved = await this.uploads.saveImage(f.buffer, originalName, mime, MEDIA_SUBFOLDER);
          return {
            path: `${MEDIA_SUBFOLDER}/${saved.filename}`,
            kind,
            name: originalName,
            size: saved.size,
            url: saved.url,
          };
        }
        // Zalo đặt tên tệp theo phần cuối URL → lưu tên gốc trong thư mục ngẫu nhiên
        const name = safeFileName(originalName);
        const dir = `${MEDIA_SUBFOLDER}/${randomBytes(8).toString('hex')}`;
        await mkdir(join(process.cwd(), 'uploads', dir), { recursive: true });
        await writeFile(join(process.cwd(), 'uploads', dir, name), f.buffer);
        return {
          path: `${dir}/${name}`,
          kind,
          name: originalName,
          size: f.size,
          url: this.uploads.getFileUrl(name, dir),
        };
      }),
    );
  }

  /** Thông tin Zalo của hội thoại (avatar, tên) + trạng thái kết bạn (chat trực tiếp). */
  async getZaloProfile(customerId: number, actorId: number, pagePid: string, contactId: number) {
    const channel = await this.assertOwnChannel(actorId, pagePid);
    const contact = await this.getContact(customerId, contactId);
    const tid = `${ZALOWEB_PREFIX}${contact.zaloId}`;
    const [thread, friend] = await Promise.all([
      this.smaxApi.getThread(channel.pid, tid).catch(() => null),
      contact.kind === 'user'
        ? this.smaxApi.getFriendStatus(channel.pid, contact.zaloId).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      kind: contact.kind,
      zaloId: contact.zaloId,
      name: thread?.name || contact.name || null,
      avatar: thread?.avatar ?? null,
      memberCount: contact.kind === 'group' ? thread?.memberCount ?? null : null,
      memberPreview: contact.kind === 'group' ? thread?.memberPreview ?? [] : [],
      friend,
      smaxUrl: `https://smax.ai/bizs/${this.smaxApi.bizAlias}/chats/${channel.pid}?tid=${tid}`,
    };
  }

  /** Gửi lời mời / đồng ý (= mời lại người đang mời mình) / thu hồi lời mời kết bạn. */
  async friendAction(
    customerId: number,
    actor: ChatActor,
    dto: { pagePid: string; contactId: number; action: 'request' | 'accept' | 'undo'; message?: string },
  ) {
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid);
    if (channel.connectionError) {
      throw new ConflictException(`Kênh "${channel.name}" đang mất kết nối`);
    }
    const contact = await this.getContact(customerId, dto.contactId);
    if (contact.kind !== 'user') throw new BadRequestException('Chỉ kết bạn với Zalo cá nhân');
    const message = (dto.message || '').trim().slice(0, 150) || 'Xin chào, mình là ' + channel.name;
    const result =
      dto.action === 'undo'
        ? await this.smaxApi.undoRequestFriend(channel.pid, contact.zaloId)
        : await this.smaxApi.requestFriend(channel.pid, contact.zaloId, message);
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { code: true },
    });
    const label = { request: 'Gửi lời mời kết bạn', accept: 'Đồng ý kết bạn', undo: 'Thu hồi lời mời kết bạn' }[dto.action];
    await this.auditLogs.create({
      actionType: 'POST',
      actionCode: 'SMAX_FRIEND_ACTION',
      entityType: 'customers',
      entityId: String(customerId),
      entityCode: customer?.code ?? undefined,
      message: `${label} Zalo qua kênh "${channel.name}" với khách ${customer?.code ?? customerId}`,
      userId: actor.id,
      userName: actor.name,
      metadata: { pagePid: channel.pid, zaloId: contact.zaloId, action: dto.action, message, result },
    });
    const friend = await this.smaxApi.getFriendStatus(channel.pid, contact.zaloId).catch(() => null);
    return { ok: true, friend };
  }

  async sendMessage(
    customerId: number,
    actor: ChatActor,
    dto: {
      pagePid: string;
      contactId: number;
      text?: string;
      attachments?: ChatAttachmentInput[];
      // Ảnh VietQR (getPaymentInfo) — URL công khai của vietqr.io, Smax tự tải
      qrImageUrl?: string;
      // Ảnh sản phẩm (product_images.id) — URL tra trong DB, không nhận URL từ client
      productImageIds?: number[];
      // Sticker Zalo — gửi thành 1 tin riêng (sau cùng)
      stickerId?: string;
      confirmed?: boolean;
    },
  ) {
    const text = (dto.text || '').trim();
    const attachments = dto.attachments ?? [];
    const qrImageUrl = dto.qrImageUrl?.trim() || null;
    if (qrImageUrl && !VIETQR_URL.test(qrImageUrl)) {
      throw new BadRequestException('Ảnh QR không hợp lệ');
    }
    const productImageUrls = await this.productImageUrls(dto.productImageIds ?? []);
    const stickerId = dto.stickerId?.trim() || null;
    if (stickerId && !/^\d{1,10}$/.test(stickerId)) {
      throw new BadRequestException('Sticker không hợp lệ');
    }
    if (!text && !attachments.length && !qrImageUrl && !productImageUrls.length && !stickerId) {
      throw new BadRequestException('Nội dung tin nhắn trống');
    }
    if (text.length > 2000) {
      throw new BadRequestException('Tin nhắn quá dài (tối đa 2000 ký tự)');
    }
    if (attachments.length + productImageUrls.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`Tối đa ${MAX_ATTACHMENTS} tệp/ảnh mỗi lần gửi`);
    }
    const urls = attachments.map((a) => this.publicMediaUrl(a.path));
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid);
    if (channel.connectionError) {
      throw new ConflictException(
        `Kênh "${channel.name}" đang mất kết nối — làm mới kết nối trên Smax trước khi gửi`,
      );
    }
    const contact = await this.getContact(customerId, dto.contactId);
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException(
        'Môi trường thử nghiệm: cần xác nhận trước khi gửi tin tới khách thật',
      );
    }
    this.checkRateLimit(actor.id);

    const to =
      contact.kind === 'group' ? { grid: contact.zaloId } : { uid: contact.zaloId };
    const steps = this.buildSteps(text, attachments, urls, [...productImageUrls, ...(qrImageUrl ? [qrImageUrl] : [])]);
    if (stickerId) steps.push({ label: 'sticker', content: { stickerId } });
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { code: true },
    });

    // Gửi lần lượt; lỗi giữa chừng thì dừng, báo rõ phần nào đã gửi
    let sent = 0;
    let failure: string | null = null;
    for (const step of steps) {
      try {
        await this.smaxApi.sendZaloweb(channel.pid, to, step.content);
        sent++;
      } catch (e) {
        if (sent === 0) throw e;
        failure = `Đã gửi ${sent}/${steps.length} phần, lỗi khi gửi ${step.label}: ${(e as Error).message}`;
        break;
      }
    }

    await this.auditLogs.create({
      actionType: 'POST',
      actionCode: 'SMAX_CHAT_SEND',
      entityType: 'customers',
      entityId: String(customerId),
      entityCode: customer?.code ?? undefined,
      message: `Gửi tin Zalo (${contact.kind === 'group' ? 'nhóm' : 'trực tiếp'}) qua kênh "${channel.name}" tới khách ${customer?.code ?? customerId}`,
      userId: actor.id,
      userName: actor.name,
      metadata: {
        pagePid: channel.pid,
        contactKind: contact.kind,
        zaloId: contact.zaloId,
        text,
        attachments: attachments.map((a, i) => ({ kind: a.kind, name: a.name, url: urls[i] })),
        ...(qrImageUrl ? { qrImageUrl } : {}),
        ...(productImageUrls.length ? { productImageUrls } : {}),
        ...(stickerId ? { stickerId } : {}),
        sentParts: sent,
        totalParts: steps.length,
        ...(failure ? { failure } : {}),
      },
    });
    if (failure) throw new HttpException(failure, HttpStatus.BAD_GATEWAY);
    return { ok: true, sentParts: sent };
  }

  /**
   * 1 lượt gửi → các lần gọi Smax: tin chữ, mọi ảnh trong 1 tin (album), rồi
   * mỗi video/tệp 1 tin riêng. Chữ KHÔNG gộp vào tin ảnh: Smax bỏ mất phần chữ
   * khi gửi kèm `images` (đã thử 26/10). Video đi qua `file` (zaloweb không có
   * trường video) → Zalo hiện dạng tệp tải về.
   */
  private buildSteps(
    text: string,
    attachments: ChatAttachmentInput[],
    urls: string[],
    // Ảnh có sẵn URL công khai (ảnh sản phẩm, QR) — gộp chung album
    extraImages: string[] = [],
  ) {
    const images = [...urls.filter((_, i) => attachments[i].kind === 'image'), ...extraImages];
    const steps: { label: string; content: ZalowebContent }[] = [];
    if (text) steps.push({ label: 'tin chữ', content: { message: text } });
    if (images.length) steps.push({ label: 'ảnh', content: { images } });
    attachments.forEach((a, i) => {
      if (a.kind !== 'image') steps.push({ label: `"${a.name}"`, content: { file: urls[i] } });
    });
    return steps;
  }

  /** URL ảnh sản phẩm theo id (giữ thứ tự chọn); chỉ nhận ảnh https Smax tải được. */
  private async productImageUrls(ids: number[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.productImage.findMany({
      where: { id: { in: ids } },
      select: { id: true, image: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.image]));
    return ids.map((id) => {
      const url = byId.get(id);
      if (!url || !/^https:\/\//.test(url)) {
        throw new BadRequestException('Ảnh sản phẩm không hợp lệ hoặc không có link công khai');
      }
      return url;
    });
  }

  /** Chỉ nhận file do uploadAttachments lưu → không gửi được URL tùy ý ra Zalo. */
  private publicMediaUrl(path: string): string {
    if (!/^smax-chat\/(?:[0-9a-f]{16}\/)?[\w.-]+$/.test(path) || path.includes('..')) {
      throw new BadRequestException('Tệp đính kèm không hợp lệ');
    }
    if (!existsSync(join(process.cwd(), 'uploads', path))) {
      throw new BadRequestException('Tệp đính kèm không còn trên máy chủ, hãy tải lên lại');
    }
    if (!this.mediaPublicUrl) {
      throw new BadRequestException(
        'Chưa cấu hình SMAX_MEDIA_PUBLIC_URL (domain https công khai của backend) — chưa gửi được tệp qua Zalo',
      );
    }
    return `${this.mediaPublicUrl}/uploads/${path}`;
  }

  async createContact(
    customerId: number,
    actorId: number,
    dto: { kind: 'user' | 'group'; zaloId: string; name?: string },
  ) {
    const zaloId = (dto.zaloId || '').trim();
    if (!/^\d{5,25}$/.test(zaloId)) {
      throw new BadRequestException('ID Zalo chỉ gồm chữ số');
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Khách hàng không tồn tại');
    if (dto.kind === 'user') {
      const existing = await this.prisma.customerZaloContact.findFirst({
        where: { customerId, kind: 'user' },
      });
      if (existing) {
        return this.prisma.customerZaloContact.update({
          where: { id: existing.id },
          data: { zaloId, name: dto.name?.trim() || null },
        });
      }
    }
    try {
      return await this.prisma.customerZaloContact.create({
        data: {
          customerId,
          kind: dto.kind,
          zaloId,
          name: dto.name?.trim() || null,
          createdById: actorId,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('ID Zalo này đã được thêm cho khách');
      }
      throw e;
    }
  }

  async updateContact(
    customerId: number,
    contactId: number,
    dto: { name?: string },
  ) {
    await this.getContact(customerId, contactId);
    return this.prisma.customerZaloContact.update({
      where: { id: contactId },
      data: { name: dto.name?.trim() || null },
    });
  }

  async deleteContact(customerId: number, contactId: number) {
    await this.getContact(customerId, contactId);
    await this.prisma.customerZaloContact.delete({ where: { id: contactId } });
    return { ok: true };
  }

  /** Nhóm Zalo có cả kênh của người gọi và khách (theo ID Zalo cá nhân đã lưu). */
  async scanSharedGroups(
    customerId: number,
    actorId: number,
    pagePid: string,
    refresh = false,
  ) {
    const channel = await this.assertOwnChannel(actorId, pagePid);
    const contacts = await this.prisma.customerZaloContact.findMany({
      where: { customerId },
    });
    const user = contacts.find((c) => c.kind === 'user');
    if (!user) {
      throw new BadRequestException(
        'Cần ID Zalo cá nhân của khách để quét nhóm chung',
      );
    }

    let cached = this.groupIndex.get(channel.pid);
    if (!cached || refresh || Date.now() - cached.at > GROUP_INDEX_TTL_MS) {
      cached = { at: Date.now(), groups: this.smaxApi.listGroupThreads(channel.pid) };
      this.groupIndex.set(channel.pid, cached);
      // Lỗi thì bỏ cache để lần sau quét lại
      cached.groups.catch(() => this.groupIndex.delete(channel.pid));
    }
    const groups = await cached.groups;

    const memberPid = `${ZALOWEB_PREFIX}${user.zaloId}`;
    const saved = new Set(
      contacts.filter((c) => c.kind === 'group').map((c) => c.zaloId),
    );
    return {
      groups: groups
        .filter((g) => g.memberPids.includes(memberPid))
        .map((g) => ({
          zaloId: g.zaloId,
          name: g.name,
          memberCount: g.memberPids.length,
          lastMessageAt: g.lastMessageAt,
          avatar: g.avatar,
          memberPreview: g.memberPreview,
          saved: saved.has(g.zaloId),
        })),
      scannedAt: new Date(cached.at).toISOString(),
      // Smax chỉ trả tối đa 500 nhóm hoạt động gần nhất
      truncated: groups.length >= GROUP_SCAN_LIMIT,
    };
  }

  /**
   * Thông tin chuyển khoản để gửi kèm tin công nợ: tài khoản ngân hàng gắn với
   * chính người dùng đang chat (như QR trên mẫu in hóa đơn) + ảnh VietQR đúng
   * số nợ (chỉ khi được xem công nợ), nội dung = mã khách.
   */
  async getPaymentInfo(customerId: number, actor: ChatActor) {
    const [customer, mapping] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { code: true, totalDebt: true },
      }),
      this.prisma.userBankAccount.findUnique({
        where: { userId: actor.id },
        include: { bankAccount: true },
      }),
    ]);
    if (!customer) throw new NotFoundException('Khách hàng không tồn tại');
    const bank = mapping?.bankAccount;
    if (!bank?.bankCode || !bank.accountNumber) return { bank: null, qrUrl: null, amount: null };
    const amount = actor.canViewDebt ? Math.max(0, Number(customer.totalDebt)) : null;
    return {
      bank: {
        bankName: bank.bankName,
        accountNumber: bank.accountNumber,
        accountHolder: bank.accountHolder,
      },
      amount,
      qrUrl: vietQrUrl(bank, amount ?? 0, customer.code ?? ''),
    };
  }

  /**
   * Hội thoại mới nhất trên các kênh Zalo cá nhân của người gọi, khớp khách POS:
   * theo ID Zalo đã lưu (mở được ngay), hoặc theo mã khách trong tên nhóm (gợi ý).
   */
  async recentChats(actorId: number, pagePid?: string) {
    const channels = (await this.myChannels(actorId)).filter(
      (c) => !c.missing && c.platform === 'zaloweb' && (!pagePid || c.pagePid === pagePid),
    );
    if (!channels.length) return { items: [] };
    const pagePids = channels.map((c) => c.pagePid).sort();
    const key = pagePids.join(',');
    let cached = this.recentCache.get(key);
    if (!cached || Date.now() - cached.at > RECENT_TTL_MS) {
      cached = { at: Date.now(), threads: this.smaxApi.listRecentThreads(pagePids, 30) };
      this.recentCache.set(key, cached);
      cached.threads.catch(() => this.recentCache.delete(key));
    }
    const threads = await cached.threads;

    const zaloIds = threads.map((t) => t.tid.slice(ZALOWEB_PREFIX.length));
    const codes = [
      ...new Set(threads.flatMap((t) => t.name.match(CUSTOMER_CODE_IN_NAME) ?? []).map((c) => c.toUpperCase())),
    ];
    const [contacts, byCode] = await Promise.all([
      this.prisma.customerZaloContact.findMany({
        where: { zaloId: { in: zaloIds } },
        select: {
          id: true,
          kind: true,
          zaloId: true,
          customer: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.customer.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true, name: true },
      }),
    ]);
    const contactByZalo = new Map<string, (typeof contacts)[number]>();
    for (const c of contacts) if (!contactByZalo.has(c.zaloId)) contactByZalo.set(c.zaloId, c);
    const customerByCode = new Map(byCode.map((c) => [c.code!.toUpperCase(), c]));
    const channelName = new Map(channels.map((c) => [c.pagePid, c.name]));

    return {
      items: threads.map((t) => {
        const zaloId = t.tid.slice(ZALOWEB_PREFIX.length);
        const contact = contactByZalo.get(zaloId);
        const codeMatch = contact
          ? undefined
          : (t.name.match(CUSTOMER_CODE_IN_NAME) ?? [])
              .map((c) => customerByCode.get(c.toUpperCase()))
              .find(Boolean);
        return {
          tid: t.tid,
          zaloId,
          pagePid: t.pagePid,
          channelName: channelName.get(t.pagePid) ?? '',
          name: t.name,
          isGroup: t.isGroup,
          lastMessage: t.lastMessage === 'attach' ? '[Tệp/ảnh]' : t.lastMessage,
          lastMessageAt: t.lastMessageAt,
          unread: t.unread,
          messageCount: t.messageCount,
          avatar: t.avatar,
          memberPreview: t.memberPreview,
          smaxUrl: `https://smax.ai/bizs/${this.smaxApi.bizAlias}/chats/${t.pagePid}?tid=${t.tid}`,
          // linked: đã lưu ID Zalo → mở ngay; byCode: đoán theo mã khách trong tên nhóm
          match: contact
            ? { type: 'linked' as const, customer: contact.customer, contactId: contact.id, kind: contact.kind }
            : codeMatch
              ? { type: 'byCode' as const, customer: codeMatch }
              : null,
        };
      }),
    };
  }

  async lookupByPhone(actorId: number, pagePid: string, phone: string) {
    // Lấy SĐT VN đầu tiên trong chuỗi rồi đổi sang 84xxxxxxxxx (Zalo báo "Số
    // điện thoại không hợp lệ" với số 0 đầu). Dữ liệu có dạng "0901391300.1",
    // "090 139 1300", "090.139.1300".
    const compact = (phone || '').replace(/[\s\-()]/g, '');
    const pattern = /(?:\+?84|0)(\d{9})(?!\d)/;
    const m = compact.match(pattern) ?? compact.replace(/\./g, '').match(pattern);
    if (!m) throw new BadRequestException('Số điện thoại không hợp lệ');
    const digits = `84${m[1]}`;
    const channel = await this.assertOwnChannel(actorId, pagePid);
    // Bọc trong object: body rỗng (null) làm client parse JSON lỗi
    return { friend: await this.smaxApi.findFriendByPhone(channel.pid, digits) };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Kênh phải liên kết với chính người gọi, còn trên Smax và là Zalo cá nhân. */
  private async assertOwnChannel(
    userId: number,
    pagePid: string,
  ): Promise<SmaxPage> {
    if (!pagePid) throw new BadRequestException('Chưa chọn kênh Zalo');
    const link = await this.prisma.smaxChannelUser.findUnique({
      where: { pagePid_userId: { pagePid, userId } },
    });
    if (!link) {
      throw new ForbiddenException('Kênh Zalo này không liên kết với tài khoản của bạn');
    }
    const page = (await this.smaxApi.listPages()).find((p) => p.pid === pagePid);
    if (!page) {
      throw new NotFoundException('Kênh Zalo không còn trên Smax');
    }
    if (page.platform !== 'zaloweb') {
      throw new BadRequestException('Chưa hỗ trợ chat qua Zalo OA trong POS');
    }
    return page;
  }

  private async getContact(customerId: number, contactId: number) {
    const contact = await this.prisma.customerZaloContact.findUnique({
      where: { id: contactId },
    });
    if (!contact || contact.customerId !== customerId) {
      throw new NotFoundException('Không tìm thấy ID Zalo của khách');
    }
    return contact;
  }

  private checkRateLimit(userId: number) {
    const now = Date.now();
    const recent = (this.sendLog.get(userId) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (recent.length >= SEND_LIMIT_PER_MINUTE) {
      throw new HttpException(
        'Gửi quá nhanh — thử lại sau ít phút',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.sendLog.set(userId, recent);
  }

  /** Chuẩn hoá tin Smax: cũ → mới, khử trùng theo pid, đánh dấu tin của mình. */
  normalize(
    raw: SmaxRawMessage[],
    pagePid: string,
    members: Record<string, string>,
  ): ChatMessage[] {
    const seen = new Set<string>();
    return raw
      .filter((m) => {
        const key = m.pid || m.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((m) => {
        const fromMe = m.sender_pid === pagePid;
        return {
          id: m.pid || m.id,
          text: m.message ?? '',
          type: m.type === 'system' ? 'system' : 'message',
          fromMe,
          senderPid: m.sender_pid ?? null,
          senderName: fromMe
            ? null
            : (m.sender_pid && members[m.sender_pid]) || null,
          attachments: (m.zaloweb?.attachments ?? [])
            .filter((a) => a?.url)
            .map((a) => ({
              url: a.url as string,
              thumbnail: a.thumbnail ?? null,
              title: a.title ?? '',
              type: a.type ?? 'file',
            })),
          albumId: m.zaloweb?.group_layout_id ?? null,
          stickerId: m.zaloweb?.sticker_id ? String(m.zaloweb.sticker_id) : null,
          createdAt: m.created_at,
        };
      })
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  }
}

/** Tên tệp an toàn cho URL: bỏ dấu tiếng Việt, ký tự lạ → "-", giữ đuôi. */
export function safeFileName(original: string): string {
  const base = original
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-\./g, '.')
    .replace(/^[-.]+|-+$/g, '');
  return (base || 'tep').slice(-120);
}

/** Link ảnh VietQR — cùng cách dựng với generateVietQRUrl của mẫu in hóa đơn. */
export function vietQrUrl(
  bank: { bankCode: string; accountNumber: string; accountHolder?: string | null },
  amount: number,
  addInfo: string,
): string {
  const params = new URLSearchParams();
  if (amount > 0) params.append('amount', String(Math.round(amount)));
  if (addInfo) params.append('addInfo', addInfo);
  if (bank.accountHolder) params.append('accountName', bank.accountHolder);
  return `https://img.vietqr.io/image/${encodeURIComponent(bank.bankCode)}-${encodeURIComponent(
    bank.accountNumber,
  )}-compact1.png?${params.toString()}`;
}
