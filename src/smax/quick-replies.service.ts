import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { existsSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UploadService } from '../upload/upload.service';

export interface QuickReplyActor {
  id: number;
  name: string;
  // Quyền smax_chat:manage_quick_replies: sửa tin nhắn nhanh chung
  canManageShared: boolean;
}

export const QUICK_REPLY_SHORTCUT_MAX = 50;
export const QUICK_REPLY_CONTENT_MAX = 2000;
export const QUICK_REPLY_MEDIA_MAX = 10;
// Đường dẫn tệp đính kèm chat đã tải lên POS (khớp SmaxChatService.publicMediaUrl)
const CHAT_MEDIA_PATH = /^smax-chat\/(?:[0-9a-f]{16}\/)?[\w.-]+$/;

export interface QuickReplyMedia {
  path: string;
  kind: 'image' | 'video' | 'file';
  name: string;
  size: number;
}

type MediaInput = Omit<QuickReplyMedia, 'size'> & { size?: number };

const select = { id: true, ownerId: true, shortcut: true, content: true, media: true, updatedAt: true } as const;
type Row = Prisma.ChatQuickReplyGetPayload<{ select: typeof select }>;

/**
 * Tin nhắn nhanh của sidechat: chung (ownerId null) — chỉ người có quyền quản lý được sửa;
 * riêng (ownerId = người tạo) — mỗi tài khoản tự sửa của mình, không ai khác thấy.
 */
@Injectable()
export class QuickRepliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly uploads: UploadService,
  ) {}

  /** Trả kèm URL xem trước của media (đường dẫn trong /uploads). */
  private view(row: Row) {
    const media = (Array.isArray(row.media) ? (row.media as unknown as QuickReplyMedia[]) : []).map((m) => ({
      ...m,
      url: this.uploads.getFileUrl(m.path),
    }));
    return { ...row, media };
  }

  async list(actor: QuickReplyActor) {
    const rows = await this.prisma.chatQuickReply.findMany({
      where: { OR: [{ ownerId: null }, { ownerId: actor.id }] },
      select,
      orderBy: [{ shortcut: 'asc' }, { id: 'asc' }],
    });
    return {
      shared: rows.filter((r) => r.ownerId === null).map((r) => this.view(r)),
      mine: rows.filter((r) => r.ownerId !== null).map((r) => this.view(r)),
      canManageShared: actor.canManageShared,
    };
  }

  async create(actor: QuickReplyActor, dto: { shared?: boolean; shortcut: string; content: string; media?: MediaInput[] }) {
    if (dto.shared && !actor.canManageShared) {
      throw new ForbiddenException('Bạn không có quyền sửa tin nhắn nhanh chung');
    }
    const data = this.clean(dto);
    const row = await this.prisma.chatQuickReply.create({
      data: { ...data, ownerId: dto.shared ? null : actor.id, createdById: actor.id },
      select,
    });
    await this.audit(actor, 'POST', 'SMAX_QUICK_REPLY_CREATE', row, `Thêm tin nhắn nhanh ${this.scope(row)} "#${row.shortcut}"`);
    return this.view(row);
  }

  async update(actor: QuickReplyActor, id: number, dto: { shortcut: string; content: string; media?: MediaInput[] }) {
    const cur = await this.editable(actor, id);
    const row = await this.prisma.chatQuickReply.update({
      where: { id },
      data: { ...this.clean(dto), updatedById: actor.id },
      select,
    });
    await this.audit(actor, 'PATCH', 'SMAX_QUICK_REPLY_UPDATE', row, `Sửa tin nhắn nhanh ${this.scope(row)} "#${row.shortcut}"`, {
      from: { shortcut: cur.shortcut, content: cur.content, media: cur.media },
    });
    return this.view(row);
  }

  async remove(actor: QuickReplyActor, id: number) {
    const cur = await this.editable(actor, id);
    await this.prisma.chatQuickReply.delete({ where: { id } });
    await this.audit(actor, 'DELETE', 'SMAX_QUICK_REPLY_DELETE', cur, `Xoá tin nhắn nhanh ${this.scope(cur)} "#${cur.shortcut}"`);
    return { ok: true };
  }

  /** Tin chung: cần quyền quản lý; tin riêng: chỉ chủ (người khác coi như không tồn tại). */
  private async editable(actor: QuickReplyActor, id: number) {
    const row = await this.prisma.chatQuickReply.findUnique({ where: { id }, select });
    if (!row || (row.ownerId !== null && row.ownerId !== actor.id)) {
      throw new NotFoundException('Không tìm thấy tin nhắn nhanh');
    }
    if (row.ownerId === null && !actor.canManageShared) {
      throw new ForbiddenException('Bạn không có quyền sửa tin nhắn nhanh chung');
    }
    return row;
  }

  private clean(dto: { shortcut: string; content: string; media?: MediaInput[] }) {
    // Mã gõ tắt: 1 từ (không khoảng trắng, không #) để gõ "#mã" trong ô soạn
    const shortcut = (dto.shortcut || '').trim().replace(/^#+/, '').replace(/\s+/g, '-');
    const content = (dto.content || '').trim();
    if (!shortcut) throw new BadRequestException('Nhập mã gõ tắt');
    if (shortcut.length > QUICK_REPLY_SHORTCUT_MAX || shortcut.includes('#')) {
      throw new BadRequestException(`Mã gõ tắt tối đa ${QUICK_REPLY_SHORTCUT_MAX} ký tự, không chứa #`);
    }
    const media = (dto.media ?? []).map((m) => ({
      path: m.path,
      kind: m.kind,
      name: (m.name || '').trim().slice(0, 255) || 'tệp',
      size: m.size ?? 0,
    }));
    if (!content && !media.length) throw new BadRequestException('Nhập nội dung hoặc thêm ảnh/tệp');
    if (content.length > QUICK_REPLY_CONTENT_MAX) {
      throw new BadRequestException(`Nội dung tối đa ${QUICK_REPLY_CONTENT_MAX} ký tự`);
    }
    if (media.length > QUICK_REPLY_MEDIA_MAX) {
      throw new BadRequestException(`Tối đa ${QUICK_REPLY_MEDIA_MAX} ảnh/tệp`);
    }
    for (const m of media) {
      // Chỉ nhận tệp đã tải lên POS (không lưu URL tuỳ ý → gửi đi sau này)
      if (!CHAT_MEDIA_PATH.test(m.path) || m.path.includes('..') || !existsSync(join(process.cwd(), 'uploads', m.path))) {
        throw new BadRequestException(`Tệp "${m.name}" không hợp lệ hoặc không còn trên máy chủ — tải lên lại`);
      }
    }
    return { shortcut, content, media: media.length ? (media as unknown as Prisma.InputJsonValue) : Prisma.DbNull };
  }

  private scope(row: { ownerId: number | null }) {
    return row.ownerId === null ? 'chung' : 'riêng';
  }

  private audit(
    actor: QuickReplyActor,
    actionType: string,
    actionCode: string,
    row: { id: number; ownerId: number | null; shortcut: string; content: string; media?: unknown },
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    return this.auditLogs.create({
      actionType,
      actionCode,
      entityType: 'chat_quick_replies',
      entityId: String(row.id),
      message,
      userId: actor.id,
      userName: actor.name,
      metadata: { ownerId: row.ownerId, shortcut: row.shortcut, content: row.content, media: row.media ?? null, ...extra } as any,
    });
  }
}
