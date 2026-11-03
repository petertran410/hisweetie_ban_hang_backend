import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
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
import { LarkUserDirectoryService } from '../lark-sync/services/lark-user-directory.service';
import { LeadLinkService } from '../leads/lead-link/lead-link.service';
import { repairUploadedFilename } from '../common/uploaded-filename.util';
import { normalizeVnPhone } from '../common/phone.util';
import {
  GROUP_SCAN_LIMIT,
  SmaxApiService,
  SmaxGroupThread,
  SmaxPage,
  SmaxRawMessage,
  SmaxRecentThread,
  ThreadMessagePart,
  ZalowebContent,
} from './smax-api.service';

/** Người dùng đang gọi (rút gọn từ req.user). */
export interface ChatActor {
  id: number;
  name: string;
  canViewOtherStaffData?: boolean;
  canViewDebt: boolean;
  canViewPackingSlips?: boolean;
  canViewLeads?: boolean;
  leadsOwnOnly?: boolean;
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
  // Tin sticker Facebook: URL ảnh sticker
  stickerImage: string | null;
  // Tin trả lời: trích tin gốc (pid để cuộn tới tin gốc)
  quote: { pid: string | null; text: string; senderName: string | null } | null;
  // Cảm xúc gộp theo icon; mine = kênh (tài khoản Zalo của mình) đã thả icon này
  reactions: { icon: string; count: number; mine: boolean; users: { name: string | null; avatar: string | null }[] }[];
  // Tin đã thu hồi (kênh hoặc khách thu hồi) — vẫn giữ nội dung để nhân viên xem
  recalled: boolean;
  createdAt: string;
}

/** Gộp cảm xúc Smax (theo người) thành theo icon, giữ thứ tự xuất hiện. */
function groupReactions(
  raw: NonNullable<SmaxRawMessage['zaloweb']>['customer_reactions'],
  pagePid: string,
  avatars: Record<string, string> = {},
): ChatMessage['reactions'] {
  const byIcon = new Map<string, ChatMessage['reactions'][number]>();
  for (const r of raw ?? []) {
    for (const i of r.icons ?? []) {
      if (!i.name) continue;
      const g = byIcon.get(i.name) ?? { icon: i.name, count: 0, mine: false, users: [] };
      g.count += Math.max(1, Number(i.number) || 1);
      if (r.customer_pid === pagePid) g.mine = true;
      const avatar = (r.customer_pid && avatars[r.customer_pid]) || r.customer_picture || null;
      g.users.push({ name: r.customer_name ?? null, avatar });
      byIcon.set(i.name, g);
    }
  }
  return [...byIcon.values()];
}

// Cảm xúc Zalo theo app Smax; NONE = thu hồi cảm xúc của mình
const REACTIONS = ['NONE', 'LIKE', 'HEART', 'HAHA', 'WOW', 'CRY', 'ANGRY'];

const SEND_LIMIT_PER_MINUTE = 20;
const GROUP_INDEX_TTL_MS = 10 * 60_000;
const RECENT_TTL_MS = 30_000;
// So khớp tên không phân biệt hoa thường / dấu tiếng Việt
const foldVi = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
// Mã khách POS trong tên nhóm Zalo, vd "… DIỆP TRÀ KH005844", "KH241166031.1"
const CUSTOMER_CODE_IN_NAME = /\bKH\d{3,}(?:\.\d+)?\b/gi;
// SĐT VN khách gõ trong tin (vd "0365692400", "+84 912 345 678", "091.234.5678")
const PHONE_IN_TEXT = /(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)/g;
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

/** Nội dung 1 lượt gửi (chữ + tệp + ảnh QR/sản phẩm + sticker). */
export interface SendContent {
  text?: string;
  attachments?: ChatAttachmentInput[];
  // Ảnh VietQR (getPaymentInfo) — URL công khai của vietqr.io, Smax tự tải
  qrImageUrl?: string;
  // Ảnh sản phẩm (product_images.id) — URL tra trong DB, không nhận URL từ client
  productImageIds?: number[];
  // Ảnh Báo đơn giao hàng (packing_slip_images.id) — cần quyền xem Báo đơn
  packingSlipImageIds?: number[];
  // Gửi ảnh trước chữ (Báo đơn 1 ảnh: ảnh rồi mới tới nội dung, như mẫu báo đơn)
  imagesFirst?: boolean;
  // Sticker Zalo — gửi thành 1 tin riêng (sau cùng)
  stickerId?: string;
  // Trả lời tin (pid); chỉ áp cho phần chữ
  replyToPid?: string;
  // Chuyển tiếp ảnh/tệp đã có trên máy chủ Zalo (chỉ nhận host Zalo)
  forwardMedia?: { url: string; kind: 'image' | 'file' }[];
  // Messenger: gửi với thẻ HUMAN_AGENT → lấy lại quyền trả lời từ Meta Business AI (như "Tự phản hồi" trên Smax)
  humanAgent?: boolean;
  confirmed?: boolean;
}

// Máy chủ ảnh/tệp/sticker của Zalo — cho phép chuyển tiếp & tải qua backend
const ZALO_MEDIA_HOST = /^https:\/\/([\w-]+\.)*(zdn\.vn|zadn\.vn|zalo\.me|dlfl\.vn|dlmd\.me)\//;
export const isZaloMediaUrl = (url: string) => ZALO_MEDIA_HOST.test(url || '');
// Ảnh QR VietQR trong mẫu in (chụp bản in hoá đơn/đặt hàng gửi vào chat — host không cho CORS)
const VIETQR_IMAGE_HOST = /^https:\/\/img\.vietqr\.io\//;
export const isProxyableMediaUrl = (url: string) => isZaloMediaUrl(url) || VIETQR_IMAGE_HOST.test(url || '');
export interface ChatAttachmentInput {
  // Đường dẫn trong /uploads do uploadAttachments trả về, vd "smax-chat/123-ab.jpg"
  path: string;
  kind: AttachmentKind;
  name: string;
}
// Kênh Zalo cá nhân: tid / pid hội thoại = "zlw" + ID Zalo (đã kiểm chứng 26/10).
const ZALOWEB_PREFIX = 'zlw';
// tid mọi kênh: tiền tố nền tảng + id (zlw…, zl…, fb…, ig…, sp…, ttw…, ctm…)
const THREAD_TID = /^[a-z]{2,4}[A-Za-z0-9_-]{3,64}$/;

/**
 * ID hội thoại của khách lưu ở customer_zalo_contacts.zalo_id:
 * - Zalo cá nhân: số Zalo (tid = "zlw" + số), dùng được với mọi kênh Zalo cá nhân.
 * - Kênh khác (Zalo OA, Facebook, Instagram, Tiktok, Shopee, Website): tid đầy đủ có tiền tố chữ
 *   (vd "fb2870…") + page_pid, vì ID khách của các nền tảng này riêng theo từng trang.
 */
const isZaloContact = (c: { zaloId: string }) => /^\d+$/.test(c.zaloId);
const contactTid = (c: { zaloId: string }) => (isZaloContact(c) ? `${ZALOWEB_PREFIX}${c.zaloId}` : c.zaloId);

/** 1 bước gửi (dạng zaloweb-messages) → các phần tin gửi vào thread của kênh khác. */
const threadParts = (c: ZalowebContent): ThreadMessagePart[] => [
  ...(c.message ? [{ message: c.message }] : []),
  ...(c.images ?? []).map((picture) => ({ picture })),
  ...(c.file ? [{ file: c.file }] : []),
];

// Người gửi đặt xe theo chi nhánh hóa đơn: nhân sự phòng ban Lark tương ứng + người thêm
// (theo tên POS); chi nhánh khác → mọi nhân sự.
const DELIVERY_SENDER_SCOPES: Record<string, { departments: string[]; users?: string[] }> = {
  'Kho Hà Nội': { departments: ['Kho Hà Nội'], users: ['Nguyễn Huyền Trang'] },
  'Kho Sài Gòn': { departments: ['Kho Sài Gòn'] },
};

/**
 * Sidebar chat Zalo trên POS: chat bằng kênh Zalo đã liên kết với CHÍNH người
 * dùng đang gọi (/cai-dat/smax) — không phụ thuộc Sale PIC.
 */
@Injectable()
export class SmaxChatService {
  private readonly logger = new Logger(SmaxChatService.name);
  private readonly sendLog = new Map<number, number[]>();
  // Chỉ mục nhóm theo kênh (quét Smax ~15s) — dùng chung giữa các khách
  private readonly recentCache = new Map<string, { at: number; threads: Promise<SmaxRecentThread[]> }>();
  private readonly groupIndex = new Map<
    string,
    { at: number; groups: Promise<SmaxGroupThread[]> }
  >();
  // Avatar bạn bè theo kênh (tải ngầm, dùng cho người thả cảm xúc)
  private readonly friendAvatars = new Map<
    string,
    { at: number; map: Record<string, string>; loading: boolean }
  >();
  private readonly confirmBeforeSend: boolean;
  // Đặt xe giao hàng: kênh + nhóm Zalo cố định (mặc định kênh "Diệp Trà Cs", nhóm "Book hộ xe")
  private readonly deliveryBooking: { pagePid: string; tid: string };
  // Domain công khai Smax tải được file đính kèm (localhost thì Smax không tới được)
  private readonly mediaPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly smaxApi: SmaxApiService,
    private readonly auditLogs: AuditLogsService,
    private readonly uploads: UploadService,
    config: ConfigService,
    private readonly larkDirectory: LarkUserDirectoryService,
    private readonly leadLink?: LeadLinkService,
  ) {
    const base = config.get<string>('SMAX_MEDIA_PUBLIC_URL')?.trim().replace(/\/+$/, '');
    this.mediaPublicUrl = base && /^https:\/\//.test(base) ? base : null;
    const flag = config.get<string>('SMAX_CHAT_CONFIRM_SEND');
    this.confirmBeforeSend =
      flag !== undefined
        ? flag === 'true'
        : config.get<string>('NODE_ENV') !== 'production';
    this.deliveryBooking = {
      pagePid: config.get<string>('SMAX_DELIVERY_PAGE_PID')?.trim() || 'zlw693698651694262958',
      tid: config.get<string>('SMAX_DELIVERY_GROUP_TID')?.trim() || 'zlw612515329498631054',
    };
  }

  /** Tải ảnh/tệp Zalo (hoặc ảnh QR VietQR) qua backend (trình duyệt bị CORS + chặn hotlink). */
  async fetchZaloMedia(url: string) {
    if (!isProxyableMediaUrl(url)) throw new BadRequestException('Chỉ tải được ảnh/tệp trên máy chủ Zalo');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new NotFoundException('Không tải được tệp từ Zalo');
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  /**
   * Gửi tin trả lời qua thread. Smax có lúc báo 5xx dù tin đã tới Zalo → kiểm tra lại
   * tin mới nhất, thấy tin vừa gửi thì coi là thành công (tránh người dùng thử lại gửi trùng).
   */
  private async sendReply(pagePid: string, tid: string, replyToPid: string, message: string) {
    const startedAt = Date.now();
    try {
      await this.smaxApi.sendThreadMessage(pagePid, tid, { replyToPid, messages: [{ message }] });
    } catch (e) {
      if (!(e instanceof BadGatewayException)) throw e;
      const latest: SmaxRawMessage[] = await this.smaxApi.getMessages(pagePid, tid).catch(() => []);
      const delivered = latest.some(
        (m) =>
          m.sender_pid === pagePid &&
          (m.message ?? '').trim() === message.trim() &&
          new Date(m.created_at).getTime() >= startedAt - 5_000,
      );
      if (!delivered) throw e;
    }
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
    const zaloContacts = customer.zaloContacts.filter(isZaloContact);
    const otherContacts = customer.zaloContacts.filter((c) => !isZaloContact(c));
    const groupZaloIds = zaloContacts.filter((c) => c.kind === 'group').map((c) => c.zaloId);
    const sharedIds = [...groupZaloIds, ...otherContacts.map((c) => c.zaloId)];
    const [salePic, channels, orders, invoices, packingSlips, shared, lead] = await Promise.all([
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
      // Báo đơn Giao hàng (PackingSlip) có hóa đơn/ký gửi của khách; Đóng hàng/Loading là bảng khác
      actor.canViewPackingSlips
        ? this.prisma.packingSlip.findMany({
            where: {
              cancelledAt: null,
              invoices: {
                some: { OR: [{ invoice: { customerId } }, { consignment: { customerId } }] },
              },
              ...(ownOnly ? { createdBy: actor.id } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
              id: true,
              code: true,
              createdAt: true,
              numberOfPackages: true,
              paymentMethod: true,
              cashAmount: true,
              invoices: {
                select: {
                  invoice: {
                    select: {
                      code: true,
                      // Hàng lạnh: có sản phẩm cargoType COLD (như cảnh báo ở Hóa đơn / Báo đơn)
                      details: { where: { product: { cargoType: 'COLD' } }, select: { id: true }, take: 1 },
                    },
                  },
                  consignment: { select: { code: true } },
                },
              },
            },
          })
        : null,
      // Khách khác cùng gắn nhóm Zalo / hội thoại kênh khác này (vd nhóm chung các chi nhánh)
      sharedIds.length
        ? this.prisma.customerZaloContact.findMany({
            where: { zaloId: { in: sharedIds }, customerId: { not: customerId } },
            select: { id: true, zaloId: true, customer: { select: { id: true, code: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve<{ id: number; zaloId: string; customer: { id: number; code: string | null; name: string } }[]>(
            [],
          ),
      // Lead nguồn của khách (cần leads:view; Sale chỉ thấy lead giao cho mình)
      this.leadLink?.leadOfCustomer(customerId, {
        canViewLeads: !!actor.canViewLeads,
        ownOnly: actor.leadsOwnOnly !== false,
        userId: actor.id,
      }) ?? null,
    ]);

    const withShared = <T extends { zaloId: string }>(c: T) => ({
      ...c,
      sharedWith: shared.filter((s) => s.zaloId === c.zaloId).map((s) => ({ ...s.customer, contactId: s.id })),
    });
    return {
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.contactNumber || customer.phone || null,
      },
      salePic,
      lead,
      myChannels: channels,
      contacts: {
        user: zaloContacts.find((c) => c.kind === 'user') ?? null,
        groups: zaloContacts.filter((c) => c.kind === 'group').map(withShared),
        // Hội thoại trên kênh khác Zalo cá nhân (mỗi cái gắn với 1 kênh — pagePid)
        others: otherContacts.map(withShared),
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
      // null = không có quyền xem Báo đơn → ẩn mục
      recentPackingSlips:
        packingSlips?.map((p) => ({
          id: p.id,
          code: p.code,
          date: p.createdAt,
          packages: p.numberOfPackages,
          paymentMethod: p.paymentMethod,
          cashAmount: p.cashAmount === null ? null : Number(p.cashAmount),
          documents: p.invoices
            .map((d) => d.invoice?.code ?? d.consignment?.code)
            .filter((c): c is string => !!c),
          hasColdItems: p.invoices.some((d) => (d.invoice?.details.length ?? 0) > 0),
        })) ?? null,
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
    return this.loadThreadMessages(channel, this.contactThread(contact, channel), before);
  }

  /** Tin của hội thoại chưa gắn khách POS (mở từ "Đang chat gần đây"). */
  async getThreadMessages(actorId: number, pagePid: string, tid: string, before?: string) {
    const channel = await this.assertOwnChannel(actorId, pagePid);
    return this.loadThreadMessages(channel, this.assertTid(tid), before);
  }

  private async loadThreadMessages(channel: SmaxPage, tid: string, before?: string) {
    const [thread, fetched, states] = await Promise.all([
      // Thông tin thread chỉ để lấy tên người gửi — Smax lỗi ở đây (đã gặp 500)
      // thì vẫn trả tin nhắn
      before ? null : this.smaxApi.getThread(channel.pid, tid).catch(() => null),
      this.smaxApi.getMessages(channel.pid, tid, before),
      // Thu hồi / xoá chỉ API nội bộ Smax có (Zalo cá nhân); lỗi thì hiện tin như thường
      channel.platform === 'zaloweb'
        ? this.smaxApi.getMessageStates(channel.pid, tid, before).catch(() => null)
        : null,
    ]);
    const raw = states ? fetched.map((m) => ({ ...m, ...states.get(m.pid) })) : fetched;
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
      messages: this.normalize(raw, channel.pid, members, {
        // Ảnh trong customer_reactions hay hết hạn → ưu tiên ảnh bạn bè (mới), ảnh kênh
        ...(thread?.memberAvatars ?? {}),
        ...(raw.some((m) => m.zaloweb?.customer_reactions?.length) ? this.peekFriendAvatars(channel.pid) : {}),
        ...(channel.picture ? { [channel.pid]: channel.picture } : {}),
      }),
      hasMore: raw.length >= 20,
      // Thả cảm xúc, thu hồi / xoá tin: Zalo cá nhân + SMAX_USER_TOKEN (API nội bộ Smax)
      canReact: channel.platform === 'zaloweb' && this.smaxApi.canReact,
    };
  }

  /**
   * Avatar bạn bè đã có trong cache; hết hạn / chưa có thì tải ngầm (không chờ:
   * danh sách lớn, lần tải tin sau sẽ có ảnh). Lỗi thì giữ ảnh cũ, thử lại sau TTL.
   */
  private peekFriendAvatars(pagePid: string): Record<string, string> {
    const entry = this.friendAvatars.get(pagePid) ?? { at: 0, map: {}, loading: false };
    this.friendAvatars.set(pagePid, entry);
    if (!entry.loading && Date.now() - entry.at > GROUP_INDEX_TTL_MS) {
      entry.loading = true;
      this.smaxApi
        .listFriendAvatars(pagePid)
        .then((map) => (entry.map = map))
        .catch(() => undefined)
        .finally(() => {
          entry.at = Date.now();
          entry.loading = false;
        });
    }
    return entry.map;
  }

  /** Thả / thu hồi (NONE) cảm xúc 1 tin, với tư cách tài khoản Zalo của kênh. */
  async reactMessage(
    actor: ChatActor,
    dto: { pagePid: string; tid: string; pid: string; reaction: string; confirmed?: boolean },
  ) {
    const tid = this.assertTid(dto.tid);
    if (!/^zlw\d{3,25}$/.test(dto.pid)) throw new BadRequestException('Tin nhắn không hợp lệ');
    if (!REACTIONS.includes(dto.reaction)) throw new BadRequestException('Cảm xúc không hợp lệ');
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid, true);
    if (channel.connectionError) {
      throw new ConflictException(`Kênh "${channel.name}" đang mất kết nối — làm mới kết nối trên Smax trước`);
    }
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException('Môi trường thử nghiệm: cần xác nhận trước khi thả cảm xúc');
    }
    this.checkRateLimit(actor.id);
    await this.smaxApi.reactMessage(channel.pid, tid, dto.pid, dto.reaction);
    await this.auditLogs.create({
      actionType: 'POST',
      actionCode: 'SMAX_CHAT_REACT',
      entityType: 'smax_threads',
      entityId: tid,
      message: `${dto.reaction === 'NONE' ? 'Thu hồi cảm xúc' : `Thả cảm xúc ${dto.reaction}`} tin Zalo qua kênh "${channel.name}"`,
      userId: actor.id,
      userName: actor.name,
      metadata: { pagePid: channel.pid, tid, pid: dto.pid, reaction: dto.reaction },
    });
    return { ok: true };
  }

  /**
   * Bật Meta Business AI trả lời hội thoại Messenger (Smax "Pass control to Meta Business AI").
   * Tắt = nhân viên gửi tin kèm humanAgent (thẻ HUMAN_AGENT), Smax không có API riêng.
   */
  async passControlBizAI(actor: ChatActor, dto: { pagePid: string; tid: string; confirmed?: boolean }) {
    const tid = this.assertTid(dto.tid);
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid);
    if (channel.platform !== 'facebook') throw new BadRequestException('Meta Business AI chỉ có trên fanpage Facebook');
    const thread = await this.smaxApi.getThread(channel.pid, tid);
    if (!thread || thread.isComment) throw new BadRequestException('Chỉ bật Meta Business AI cho hội thoại Messenger');
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException('Môi trường thử nghiệm: cần xác nhận trước khi bật Meta Business AI');
    }
    this.checkRateLimit(actor.id);
    await this.smaxApi.passControlBizAI(channel.pid, tid);
    await this.auditLogs.create({
      actionType: 'POST',
      actionCode: 'SMAX_META_AI_ON',
      entityType: 'smax_threads',
      entityId: tid,
      message: `Bật Meta Business AI trả lời hội thoại Messenger "${thread.name}" (kênh "${channel.name}")`,
      userId: actor.id,
      userName: actor.name,
      metadata: { pagePid: channel.pid, tid },
    });
    return { ok: true };
  }

  /** Thu hồi (cả 2 phía) / xoá phía mình 1 tin Zalo, với tư cách tài khoản Zalo của kênh. */
  async messageAction(
    actor: ChatActor,
    dto: { pagePid: string; tid: string; pid: string; action: 'recall' | 'delete'; confirmed?: boolean },
  ) {
    const tid = this.assertTid(dto.tid);
    if (!/^zlw\d{3,25}$/.test(dto.pid)) throw new BadRequestException('Tin nhắn không hợp lệ');
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid, true);
    if (channel.connectionError) {
      throw new ConflictException(`Kênh "${channel.name}" đang mất kết nối — làm mới kết nối trên Smax trước`);
    }
    const label = dto.action === 'recall' ? 'thu hồi' : 'xoá';
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException(`Môi trường thử nghiệm: cần xác nhận trước khi ${label} tin`);
    }
    this.checkRateLimit(actor.id);
    await this.smaxApi.messageAction(channel.pid, tid, dto.pid, dto.action);
    await this.auditLogs.create({
      actionType: 'POST',
      actionCode: dto.action === 'recall' ? 'SMAX_CHAT_RECALL' : 'SMAX_CHAT_DELETE',
      entityType: 'smax_threads',
      entityId: tid,
      message: `${dto.action === 'recall' ? 'Thu hồi' : 'Xoá (phía mình)'} tin Zalo qua kênh "${channel.name}"`,
      userId: actor.id,
      userName: actor.name,
      metadata: { pagePid: channel.pid, tid, pid: dto.pid, action: dto.action },
    });
    return { ok: true };
  }

  /** tid hội thoại: tiền tố nền tảng + id (Zalo cá nhân = "zlw" + ID Zalo cá nhân/nhóm). */
  private assertTid(tid: string): string {
    if (!THREAD_TID.test(tid || '')) throw new BadRequestException('Hội thoại không hợp lệ');
    return tid;
  }

  /** tid của ID đã lưu cho khách, phải đúng loại kênh (Zalo cá nhân / đúng trang của kênh khác). */
  private contactThread(contact: { zaloId: string; pagePid: string | null }, channel: SmaxPage): string {
    if (isZaloContact(contact)) {
      if (channel.platform !== 'zaloweb') {
        throw new BadRequestException('ID Zalo cá nhân của khách chỉ dùng với kênh Zalo cá nhân');
      }
    } else if (contact.pagePid !== channel.pid) {
      throw new BadRequestException('Hội thoại này thuộc kênh khác — chọn đúng kênh để chat');
    }
    return contactTid(contact);
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

  /** Thông tin hội thoại (avatar, tên) + trạng thái kết bạn (chat trực tiếp Zalo cá nhân). */
  async getZaloProfile(customerId: number, actorId: number, pagePid: string, contactId: number) {
    const channel = await this.assertOwnChannel(actorId, pagePid);
    const contact = await this.getContact(customerId, contactId);
    return this.loadProfile(channel, contact.kind as 'user' | 'group', this.contactThread(contact, channel), contact.name);
  }

  /** Avatar / tên / trạng thái kết bạn của hội thoại chưa gắn khách POS. */
  async getThreadProfile(actorId: number, pagePid: string, tid: string, isGroup: boolean) {
    const channel = await this.assertOwnChannel(actorId, pagePid);
    return this.loadProfile(channel, isGroup ? 'group' : 'user', this.assertTid(tid), null);
  }

  private async loadProfile(
    channel: SmaxPage,
    kind: 'user' | 'group',
    tid: string,
    fallbackName: string | null,
  ) {
    const zaloweb = channel.platform === 'zaloweb';
    // Zalo cá nhân: ID Zalo (bỏ "zlw"); kênh khác: tid
    const zaloId = zaloweb ? tid.slice(ZALOWEB_PREFIX.length) : tid;
    const [thread, friend] = await Promise.all([
      this.smaxApi.getThread(channel.pid, tid).catch(() => null),
      zaloweb && kind === 'user'
        ? this.smaxApi.getFriendStatus(channel.pid, zaloId).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      kind,
      zaloId,
      platform: channel.platform,
      // Smax báo không trả lời được qua API (Facebook ngoài 24h, Shopee…) → client cảnh báo
      canReply: thread?.canReply ?? true,
      // Bình luận bài viết: mở thẳng bài viết / bình luận trên Facebook
      isComment: thread?.isComment ?? false,
      // Messenger đang do Meta Business AI trả lời (bật/tắt trên POS)
      controlledBy: thread?.controlledBy ?? null,
      canPassControlAI: channel.platform === 'facebook' && !!thread && !thread.isComment && this.smaxApi.canReact,
      commentUrl: thread?.commentUrl ?? null,
      name: thread?.name || fallbackName || null,
      avatar: thread?.avatar ?? null,
      memberCount: kind === 'group' ? thread?.memberCount ?? null : null,
      memberPreview: kind === 'group' ? thread?.memberPreview ?? [] : [],
      friend,
      smaxUrl: `https://smax.ai/bizs/${this.smaxApi.bizAlias}/chats/${channel.pid}?tid=${tid}`,
      confirmBeforeSend: this.confirmBeforeSend,
    };
  }

  /** Gửi lời mời / đồng ý (= mời lại người đang mời mình) / thu hồi lời mời kết bạn. */
  async friendAction(
    customerId: number,
    actor: ChatActor,
    dto: { pagePid: string; contactId: number; action: 'request' | 'accept' | 'undo'; message?: string },
  ) {
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid, true);
    if (channel.connectionError) {
      throw new ConflictException(`Kênh "${channel.name}" đang mất kết nối`);
    }
    const contact = await this.getContact(customerId, dto.contactId);
    if (contact.kind !== 'user' || !isZaloContact(contact)) throw new BadRequestException('Chỉ kết bạn với Zalo cá nhân');
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

  async sendMessage(customerId: number, actor: ChatActor, dto: SendContent & { pagePid: string; contactId: number }) {
    const contact = await this.getContact(customerId, dto.contactId);
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { code: true },
    });
    return this.deliver(actor, dto, { kind: contact.kind as 'user' | 'group', tidFor: (ch) => this.contactThread(contact, ch) }, {
      entityType: 'customers',
      entityId: String(customerId),
      entityCode: customer?.code ?? undefined,
      label: `khách ${customer?.code ?? customerId}`,
    });
  }

  /** Gửi vào hội thoại chưa gắn khách POS (theo tid). */
  async sendToThread(
    actor: ChatActor,
    dto: SendContent & { pagePid: string; tid: string; isGroup?: boolean },
  ) {
    const tid = this.assertTid(dto.tid);
    return this.deliver(
      actor,
      dto,
      { kind: dto.isGroup ? 'group' : 'user', tidFor: () => tid },
      { entityType: 'smax_threads', entityId: tid, label: `hội thoại ${tid} (chưa gắn khách POS)` },
    );
  }

  private async deliver(
    actor: ChatActor,
    dto: SendContent & { pagePid: string },
    // tid theo kênh đã kiểm tra (ID đã lưu phải đúng loại kênh)
    target: { kind: 'user' | 'group'; tidFor: (channel: SmaxPage) => string },
    audit: { entityType: string; entityId: string; entityCode?: string; label: string },
  ) {
    const text = (dto.text || '').trim();
    const attachments = dto.attachments ?? [];
    const qrImageUrl = dto.qrImageUrl?.trim() || null;
    if (qrImageUrl && !VIETQR_URL.test(qrImageUrl)) {
      throw new BadRequestException('Ảnh QR không hợp lệ');
    }
    const productImageUrls = await this.productImageUrls(dto.productImageIds ?? []);
    if (dto.packingSlipImageIds?.length && !actor.canViewPackingSlips) {
      throw new ForbiddenException('Bạn không có quyền xem Báo đơn');
    }
    const slipImageUrls = await this.packingSlipImageUrls(dto.packingSlipImageIds ?? []);
    const stickerId = dto.stickerId?.trim() || null;
    if (stickerId && !/^\d{1,10}$/.test(stickerId)) {
      throw new BadRequestException('Sticker không hợp lệ');
    }
    const forwardMedia = dto.forwardMedia ?? [];
    if (forwardMedia.some((m) => !isZaloMediaUrl(m.url))) {
      throw new BadRequestException('Chỉ chuyển tiếp được ảnh/tệp trên máy chủ Zalo');
    }
    const replyToPid = dto.replyToPid?.trim() || null;
    if (replyToPid && (!/^[\w-]{3,200}$/.test(replyToPid) || !text)) {
      throw new BadRequestException('Trả lời tin cần có nội dung chữ');
    }
    if (
      !text &&
      !attachments.length &&
      !qrImageUrl &&
      !productImageUrls.length &&
      !slipImageUrls.length &&
      !stickerId &&
      !forwardMedia.length
    ) {
      throw new BadRequestException('Nội dung tin nhắn trống');
    }
    if (text.length > 2000) {
      throw new BadRequestException('Tin nhắn quá dài (tối đa 2000 ký tự)');
    }
    if (
      attachments.length + productImageUrls.length + slipImageUrls.length + forwardMedia.length >
      MAX_ATTACHMENTS
    ) {
      throw new BadRequestException(`Tối đa ${MAX_ATTACHMENTS} tệp/ảnh mỗi lần gửi`);
    }
    const urls = attachments.map((a) => this.publicMediaUrl(a.path));
    const channel = await this.assertOwnChannel(actor.id, dto.pagePid);
    if (channel.connectionError) {
      throw new ConflictException(
        `Kênh "${channel.name}" đang mất kết nối — làm mới kết nối trên Smax trước khi gửi`,
      );
    }
    const zaloweb = channel.platform === 'zaloweb';
    const tid = target.tidFor(channel);
    if (zaloweb && !/^zlw\d{3,25}$/.test(tid)) throw new BadRequestException('Hội thoại không hợp lệ');
    if (stickerId && !zaloweb) throw new BadRequestException('Sticker chỉ gửi được qua Zalo cá nhân');
    const humanAgent = !!dto.humanAgent && channel.platform === 'facebook';
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException(
        'Môi trường thử nghiệm: cần xác nhận trước khi gửi tin tới khách thật',
      );
    }
    this.checkRateLimit(actor.id);

    const zaloId = tid.slice(ZALOWEB_PREFIX.length);
    const to = target.kind === 'group' ? { grid: zaloId } : { uid: zaloId };
    const steps = this.buildSteps(text, attachments, urls, [
      ...slipImageUrls,
      ...productImageUrls,
      ...forwardMedia.filter((m) => m.kind === 'image').map((m) => m.url),
      ...(qrImageUrl ? [qrImageUrl] : []),
    ], !!dto.imagesFirst);
    for (const m of forwardMedia) {
      if (m.kind === 'file') steps.push({ label: 'tệp chuyển tiếp', content: { file: m.url } });
    }
    if (stickerId) steps.push({ label: 'sticker', content: { stickerId } });

    // Gửi lần lượt; lỗi giữa chừng thì dừng, báo rõ phần nào đã gửi
    let sent = 0;
    let failure: string | null = null;
    for (const step of steps) {
      try {
        const isText = !!step.content.message && Object.keys(step.content).length === 1;
        if (!zaloweb) {
          // Kênh khác: gửi vào thread; trả lời (trích dẫn) áp cho phần chữ
          await this.smaxApi.sendThreadMessage(channel.pid, tid, {
            ...(replyToPid && isText ? { replyToPid } : {}),
            messages: threadParts(step.content).map((p) =>
              humanAgent ? { ...p, message_tag: 'HUMAN_AGENT' } : p,
            ),
          });
        } else if (replyToPid && isText) {
          // Trả lời: phần chữ đi qua thread để Zalo hiện trích dẫn
          await this.sendReply(channel.pid, tid, replyToPid, step.content.message!);
        } else {
          await this.smaxApi.sendZaloweb(channel.pid, to, step.content);
        }
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
      entityType: audit.entityType,
      entityId: audit.entityId,
      entityCode: audit.entityCode,
      message: `Gửi tin ${zaloweb ? `Zalo (${target.kind === 'group' ? 'nhóm' : 'trực tiếp'})` : channel.platform} qua kênh "${channel.name}" tới ${audit.label}`,
      userId: actor.id,
      userName: actor.name,
      metadata: {
        pagePid: channel.pid,
        platform: channel.platform,
        contactKind: target.kind,
        tid,
        text,
        attachments: attachments.map((a, i) => ({ kind: a.kind, name: a.name, url: urls[i] })),
        ...(qrImageUrl ? { qrImageUrl } : {}),
        ...(productImageUrls.length ? { productImageUrls } : {}),
        ...(slipImageUrls.length ? { packingSlipImageUrls: slipImageUrls } : {}),
        ...(stickerId ? { stickerId } : {}),
        ...(replyToPid ? { replyToPid } : {}),
        ...(forwardMedia.length ? { forwardMedia } : {}),
        ...(humanAgent ? { humanAgent } : {}),
        sentParts: sent,
        totalParts: steps.length,
        ...(failure ? { failure } : {}),
      },
    });
    if (failure) throw new HttpException(failure, HttpStatus.BAD_GATEWAY);
    return { ok: true, sentParts: sent };
  }

  /** Kênh + nhóm Zalo nhận tin đặt xe giao hàng (để hiện trong modal trước khi gửi). */
  async deliveryBookingTarget() {
    const { pagePid, tid } = this.deliveryBooking;
    const [channel, thread] = await Promise.all([
      this.deliveryBookingChannel(),
      this.smaxApi.getThread(pagePid, tid).catch(() => null),
    ]);
    return {
      channelName: channel.name,
      groupName: thread?.name ?? null,
      connectionError: !!channel.connectionError,
      confirmBeforeSend: this.confirmBeforeSend,
    };
  }

  /**
   * Nhân viên được chọn làm người gửi đặt xe cho chi nhánh (`null` = mọi nhân sự). Lark lỗi
   * hoặc không khớp ai → `null` để không chặn việc đặt xe.
   */
  async deliveryBookingSenders(branchId: number): Promise<{ userIds: number[] | null }> {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } });
    const scope = branch ? DELIVERY_SENDER_SCOPES[branch.name.trim()] : undefined;
    if (!scope) return { userIds: null };
    let openIds: Set<string>;
    try {
      openIds = await this.larkDirectory.openIdsInDepartments(scope.departments);
    } catch (error) {
      this.logger.warn(`Không đọc được phòng ban Lark ${scope.departments.join(', ')}: ${(error as Error).message}`);
      return { userIds: null };
    }
    const users = await this.prisma.user.findMany({
      where: { isActive: true, OR: [{ larkUserId: { in: [...openIds] } }, { name: { in: scope.users ?? [] } }] },
      select: { id: true },
    });
    return { userIds: users.length ? users.map((u) => u.id) : null };
  }

  /**
   * Đặt xe giao hàng cho 1 hoặc nhiều hóa đơn (1 tin, nhiều người nhận): gửi tin vào nhóm
   * đặt xe qua kênh cố định — không cần kênh liên kết với người bấm (quyền invoices:update),
   * ghi nhật ký theo từng hóa đơn.
   */
  async bookDelivery(
    actor: ChatActor,
    dto: { invoiceId?: number; invoiceIds?: number[]; text: string; confirmed?: boolean },
  ) {
    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Nội dung tin nhắn trống');
    const ids = [...new Set(dto.invoiceIds?.length ? dto.invoiceIds : dto.invoiceId ? [dto.invoiceId] : [])];
    if (!ids.length) throw new BadRequestException('Chưa chọn hóa đơn');
    const invoices = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    if (invoices.length !== ids.length) throw new NotFoundException('Không tìm thấy hóa đơn');
    const channel = await this.deliveryBookingChannel();
    if (channel.connectionError) {
      throw new ConflictException(
        `Kênh "${channel.name}" đang mất kết nối — làm mới kết nối trên Smax trước khi gửi`,
      );
    }
    if (this.confirmBeforeSend && !dto.confirmed) {
      throw new BadRequestException('Môi trường thử nghiệm: cần xác nhận trước khi gửi tin');
    }
    this.checkRateLimit(actor.id);

    const { tid } = this.deliveryBooking;
    await this.smaxApi.sendZaloweb(channel.pid, { grid: tid.slice(ZALOWEB_PREFIX.length) }, { message: text });
    const codes = invoices.map((i) => i.code);
    for (const invoice of invoices) {
      const others = codes.filter((c) => c !== invoice.code);
      await this.auditLogs.create({
        actionType: 'POST',
        actionCode: 'SMAX_DELIVERY_BOOKING',
        entityType: 'invoices',
        entityId: String(invoice.id),
        entityCode: invoice.code,
        message: `Đặt xe giao hàng hóa đơn ${invoice.code}${
          others.length ? ` (gộp chung chuyến với ${others.join(', ')})` : ''
        }: gửi tin Zalo qua kênh "${channel.name}" vào nhóm đặt xe`,
        userId: actor.id,
        userName: actor.name,
        metadata: { pagePid: channel.pid, tid, text, invoiceCodes: codes },
      });
    }
    return { ok: true };
  }

  private async deliveryBookingChannel(): Promise<SmaxPage> {
    const page = (await this.smaxApi.listPages()).find((p) => p.pid === this.deliveryBooking.pagePid);
    if (!page) throw new NotFoundException('Kênh Zalo đặt xe không còn trên Smax');
    return page;
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
    imagesFirst = false,
  ) {
    const images = [...urls.filter((_, i) => attachments[i].kind === 'image'), ...extraImages];
    const steps: { label: string; content: ZalowebContent }[] = [];
    if (text) steps.push({ label: 'tin chữ', content: { message: text } });
    if (images.length) {
      const step = { label: 'ảnh', content: { images } };
      if (imagesFirst) steps.unshift(step);
      else steps.push(step);
    }
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

  /** URL ảnh Báo đơn theo id (giữ thứ tự chọn); chỉ nhận ảnh https Smax tải được. */
  private async packingSlipImageUrls(ids: number[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.packingSlipImage.findMany({
      where: { id: { in: ids } },
      select: { id: true, imageUrl: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.imageUrl]));
    return ids.map((id) => {
      const url = byId.get(id);
      if (!url || !/^https:\/\//.test(url)) {
        throw new BadRequestException('Ảnh báo đơn không hợp lệ hoặc không có link công khai');
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

  /**
   * Lưu ID hội thoại cho khách: số Zalo (Zalo cá nhân), hoặc tid kênh khác (fb…, zl…, sp…) kèm
   * pagePid. Mỗi khách 1 ID Zalo cá nhân và 1 hội thoại trực tiếp mỗi kênh khác (gắn lại = thay).
   */
  async createContact(
    customerId: number,
    actor: { id: number; name: string },
    dto: { kind: 'user' | 'group'; zaloId: string; name?: string; pagePid?: string },
  ) {
    const contact = await this.saveContact(customerId, actor.id, dto);
    // Lead chưa gắn có cùng ID Zalo (tra khi chuyển giao) / cùng hội thoại → tự gắn vào khách
    const linkedLead = await this.leadLink
      ?.linkByContact(customerId, contact, actor)
      .catch((e) => {
        this.logger.warn(`Gắn lead theo ID Zalo khách ${customerId} lỗi: ${(e as Error).message}`);
        return null;
      });
    return { ...contact, linkedLead: linkedLead ?? null };
  }

  private async saveContact(
    customerId: number,
    actorId: number,
    dto: { kind: 'user' | 'group'; zaloId: string; name?: string; pagePid?: string },
  ) {
    // tid Zalo cá nhân ("zlw" + số) → lưu số như ID nhập tay
    const zaloId = (dto.zaloId || '').trim().replace(/^zlw(?=\d+$)/, '');
    const isTid = !/^\d+$/.test(zaloId);
    if (isTid ? !THREAD_TID.test(zaloId) : !/^\d{5,25}$/.test(zaloId)) {
      throw new BadRequestException('ID Zalo chỉ gồm chữ số');
    }
    let pagePid: string | null = null;
    if (isTid) {
      pagePid = dto.pagePid?.trim() || null;
      const page = pagePid ? (await this.smaxApi.listPages()).find((p) => p.pid === pagePid) : null;
      if (!page || page.platform === 'zaloweb') {
        throw new BadRequestException('Hội thoại cần kèm đúng kênh (không phải Zalo cá nhân) trên Smax');
      }
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Khách hàng không tồn tại');
    if (dto.kind === 'user') {
      const existing = (
        await this.prisma.customerZaloContact.findMany({ where: { customerId, kind: 'user' } })
      ).find((c) => (isTid ? !isZaloContact(c) && c.pagePid === pagePid : isZaloContact(c)));
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
          pagePid,
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
    const channel = await this.assertOwnChannel(actorId, pagePid, true);
    const contacts = (
      await this.prisma.customerZaloContact.findMany({
        where: { customerId },
      })
    ).filter(isZaloContact);
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
   * Hội thoại mới nhất trên kênh của người gọi, khớp khách POS: theo ID đã lưu (mở được ngay),
   * hoặc gợi ý theo mã khách trong tên nhóm / SĐT khách Smax thu được (Facebook…).
   * Không truyền pagePid = mọi kênh Zalo cá nhân; truyền pagePid = đúng kênh đó (mọi nền tảng).
   */
  async recentChats(actorId: number, pagePid?: string, limit = 30, q?: string) {
    // Thanh thu gọn xin thêm khi bấm "…" (Smax: 100 hội thoại ~2s, nên chỉ lấy khi cần)
    const take = Math.min(200, Math.max(10, Math.round(limit)));
    const keyword = q?.trim().slice(0, 100) || undefined;
    const channels = (await this.myChannels(actorId)).filter(
      (c) => !c.missing && (pagePid ? c.pagePid === pagePid : c.platform === 'zaloweb'),
    );
    if (!channels.length) return { items: [] };
    const pagePids = channels.map((c) => c.pagePid).sort();
    const key = `${pagePids.join(',')}:${take}:${keyword ?? ''}`;
    let cached = this.recentCache.get(key);
    if (!cached || Date.now() - cached.at > RECENT_TTL_MS) {
      // Mỗi từ khoá tìm là 1 mục cache → dọn mục hết hạn để map không phình
      for (const [k, v] of this.recentCache) if (Date.now() - v.at > RECENT_TTL_MS) this.recentCache.delete(k);
      cached = { at: Date.now(), threads: this.smaxApi.listRecentThreads(pagePids, take, keyword) };
      this.recentCache.set(key, cached);
      cached.threads.catch(() => this.recentCache.delete(key));
    }
    let threads = await cached.threads;
    // Smax khớp cả thành viên nhóm & nội dung tin → chỉ giữ hội thoại khớp tên Zalo / tên nhóm
    if (keyword) threads = threads.filter((t) => foldVi(t.name).includes(foldVi(keyword)));

    // ID đã lưu: số Zalo (Zalo cá nhân) hoặc tid (kênh khác)
    const zalowebTid = (t: SmaxRecentThread) => /^zlw\d+$/.test(t.tid);
    const idOf = (t: SmaxRecentThread) => (zalowebTid(t) ? t.tid.slice(ZALOWEB_PREFIX.length) : t.tid);
    const zaloIds = threads.map(idOf);
    const codes = [
      ...new Set(threads.flatMap((t) => t.name.match(CUSTOMER_CODE_IN_NAME) ?? []).map((c) => c.toUpperCase())),
    ];
    // Hội thoại đã gắn lead (trang Lead) → hiện "Lead · tên", tránh tạo trùng; SĐT lead dùng để gợi ý khách
    const leadConvs = await this.prisma.leadConversation.findMany({
      where: { tid: { in: threads.map((t) => t.tid) } },
      select: {
        tid: true,
        pagePid: true,
        lead: { select: { id: true, name: true, status: true, phoneNormalized: true } },
      },
    });
    const leadOf = (t: SmaxRecentThread) => leadConvs.find((l) => l.tid === t.tid && l.pagePid === t.pagePid)?.lead;
    // SĐT để gợi ý gắn khách POS (kênh khác Zalo cá nhân): Smax thu được, có trong tin, SĐT lead
    const phonesOf = (t: SmaxRecentThread): string[] =>
      zalowebTid(t)
        ? []
        : [
            ...new Set(
              [...t.phones, ...(t.lastMessage.match(PHONE_IN_TEXT) ?? []), leadOf(t)?.phoneNormalized ?? '']
                .map((p) => normalizeVnPhone(p))
                .filter((p): p is string => !!p),
            ),
          ];
    const phones = [...new Set(threads.flatMap(phonesOf))];
    const [contacts, byCode, byPhone] = await Promise.all([
      this.prisma.customerZaloContact.findMany({
        where: { zaloId: { in: zaloIds } },
        select: {
          id: true,
          kind: true,
          zaloId: true,
          pagePid: true,
          customer: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.customer.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true, name: true },
      }),
      // SĐT khách có thể kèm hậu tố trùng (".1") → so đầu chuỗi
      phones.length
        ? this.prisma.customer.findMany({
            where: {
              OR: phones.flatMap((p) => [{ contactNumber: { startsWith: p } }, { phone: { startsWith: p } }]),
            },
            select: { id: true, code: true, name: true, contactNumber: true, phone: true },
            take: 100,
          })
        : Promise.resolve(
            [] as { id: number; code: string | null; name: string; contactNumber: string | null; phone: string | null }[],
          ),
    ]);
    // 1 nhóm có thể gắn nhiều khách (vd nhóm chung các chi nhánh) → giữ tất cả, khách gắn trước đứng đầu
    const contactsByZalo = new Map<string, (typeof contacts)[number][]>();
    for (const c of contacts) contactsByZalo.set(c.zaloId, [...(contactsByZalo.get(c.zaloId) ?? []), c]);
    const customerByCode = new Map(byCode.map((c) => [c.code!.toUpperCase(), c]));
    const channelName = new Map(channels.map((c) => [c.pagePid, c.name]));

    return {
      items: threads.map((t) => {
        const zaloId = idOf(t);
        // tid kênh khác chỉ khớp ID lưu cho đúng trang
        const linked = (contactsByZalo.get(zaloId) ?? []).filter(
          (c) => zalowebTid(t) || c.pagePid === t.pagePid,
        );
        const contact = linked[0];
        const codeMatch = contact
          ? undefined
          : (t.name.match(CUSTOMER_CODE_IN_NAME) ?? [])
              .map((c) => customerByCode.get(c.toUpperCase()))
              .find(Boolean);
        const tPhones = phonesOf(t);
        const lead = leadOf(t);
        const phoneMatch =
          contact || codeMatch
            ? undefined
            : byPhone.find((c) => tPhones.some((p) => (c.contactNumber ?? '').startsWith(p) || (c.phone ?? '').startsWith(p)));
        return {
          tid: t.tid,
          zaloId,
          pagePid: t.pagePid,
          platform: t.platform,
          isComment: t.isComment,
          phones: t.phones,
          lead: lead ? { id: lead.id, name: lead.name, status: lead.status } : null,
          // Messenger: bật/tắt Meta Business AI ngay trên danh sách (bật cần SMAX_USER_TOKEN)
          controlledBy: t.controlledBy,
          canPassControlAI: t.platform === 'facebook' && !t.isComment && this.smaxApi.canReact,
          canReply: t.canReply,
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
          // linked: đã lưu ID → mở ngay; byCode / byPhone: gợi ý theo mã khách trong tên nhóm / SĐT
          match: contact
            ? {
                type: 'linked' as const,
                customer: contact.customer,
                contactId: contact.id,
                kind: contact.kind,
                customers: linked.map((c) => ({ ...c.customer, contactId: c.id })),
              }
            : codeMatch
              ? { type: 'byCode' as const, customer: codeMatch }
              : phoneMatch
                ? { type: 'byPhone' as const, customer: { id: phoneMatch.id, code: phoneMatch.code, name: phoneMatch.name } }
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
    const channel = await this.assertOwnChannel(actorId, pagePid, true);
    // Bọc trong object: body rỗng (null) làm client parse JSON lỗi
    return { friend: await this.smaxApi.findFriendByPhone(channel.pid, digits) };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /**
   * Kênh phải liên kết với chính người gọi và còn trên Smax. zalowebOnly: thao tác chỉ Zalo cá
   * nhân có (thả cảm xúc, thu hồi, kết bạn, quét nhóm chung, tra SĐT Zalo).
   */
  private async assertOwnChannel(
    userId: number,
    pagePid: string,
    zalowebOnly = false,
  ): Promise<SmaxPage> {
    if (!pagePid) throw new BadRequestException('Chưa chọn kênh');
    const link = await this.prisma.smaxChannelUser.findUnique({
      where: { pagePid_userId: { pagePid, userId } },
    });
    if (!link) {
      throw new ForbiddenException('Kênh này không liên kết với tài khoản của bạn');
    }
    const page = (await this.smaxApi.listPages()).find((p) => p.pid === pagePid);
    if (!page) {
      throw new NotFoundException('Kênh không còn trên Smax');
    }
    if (zalowebOnly && page.platform !== 'zaloweb') {
      throw new BadRequestException('Thao tác này chỉ có trên kênh Zalo cá nhân');
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

  /**
   * Kênh Zalo cá nhân đã liên kết với 1 người dùng (vd Sale PIC khi CSKH chuyển giao lead thay
   * mặt Sale): còn trên Smax, đúng loại Zalo cá nhân.
   */
  userZaloChannel(userId: number, pagePid: string): Promise<SmaxPage> {
    return this.assertOwnChannel(userId, pagePid, true);
  }

  /** Giới hạn tần suất gửi tin chung cho mọi luồng gửi Zalo của 1 người dùng. */
  assertSendRate(userId: number) {
    this.checkRateLimit(userId);
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
    avatars: Record<string, string> = {},
  ): ChatMessage[] {
    const seen = new Set<string>();
    return raw
      .filter((m) => {
        // Đã xoá phía mình → ẩn như trên Zalo
        if (m.deleted?.at) return false;
        const key = m.pid || m.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((m) => {
        const fromMe = m.sender_pid === pagePid;
        // Ảnh/tệp nằm ở phần riêng của nền tảng: m.zaloweb, m.zalo, m.facebook, m.shopee…
        const part = (m.zaloweb ??
          (m as unknown as Record<string, { attachments?: NonNullable<SmaxRawMessage['zaloweb']>['attachments'] }>)[
            m.platform ?? ''
          ]) as { attachments?: NonNullable<SmaxRawMessage['zaloweb']>['attachments'] } | undefined;
        const fbSticker = m.facebook?.sticker || null;
        return {
          id: m.pid || m.id,
          text: m.message ?? '',
          type: m.type === 'system' ? 'system' : 'message',
          fromMe,
          senderPid: m.sender_pid ?? null,
          senderName: fromMe
            ? null
            : (m.sender_pid && members[m.sender_pid]) || null,
          // Sticker Facebook đã hiện qua stickerImage → bỏ attachment trùng
          attachments: (fbSticker ? [] : (part?.attachments ?? []))
            .filter((a) => a?.url)
            .map((a) => ({
              url: a.url as string,
              thumbnail: a.thumbnail ?? a.url_preview ?? null,
              title: a.title ?? a.name ?? '',
              type: a.type ?? mimeKind(a.mime_type),
            })),
          albumId: m.zaloweb?.group_layout_id ?? null,
          stickerId: m.zaloweb?.sticker_id ? String(m.zaloweb.sticker_id) : null,
          stickerImage: fbSticker,
          quote: m.zaloweb?.quote
            ? {
                pid: m.zaloweb.quote.global_msg_id ? `${ZALOWEB_PREFIX}${m.zaloweb.quote.global_msg_id}` : null,
                text: m.zaloweb.quote.msg ?? '',
                senderName: m.zaloweb.quote.reply_to_name ?? null,
              }
            : null,
          reactions: groupReactions(m.zaloweb?.customer_reactions, pagePid, avatars),
          recalled: m.status === 'deleted',
          createdAt: m.created_at,
        };
      })
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  }
}

/** Loại tệp theo mime_type Facebook ("image", "image/png", "video/mp4"…) → image | video | audio | file. */
function mimeKind(mime?: string): string {
  const kind = mime?.split('/')[0];
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'file';
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
