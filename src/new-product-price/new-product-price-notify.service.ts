import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import {
  FRONTEND_PATH,
  NPP_EVENT,
  NPP_GROUP,
  NppGroup,
  NppStage,
} from './new-product-price.constants';
import { isManufactured } from './new-product-price.rules';
import { NewProductPriceConfigService } from './new-product-price-config.service';
import {
  BuiltCard,
  NppNotifyKind,
  ReminderItem,
  buildReminderCard,
  buildTicketCard,
  buildTopicReply,
  buildTopicRootCard,
} from './new-product-price-lark-cards';
import { pickTopicRoot, postToTopic } from '../lark-sync/lark-topic';

export interface NotifyContext {
  actorId?: number | null;
  reason?: string | null;
  decision?: 'APPROVED' | 'REJECTED';
  decidedByName?: string | null;
  ended?: boolean;
}

type DeliveryStatus = 'SENT' | 'NO_LARK' | 'ERROR';
interface Delivery {
  userId: number;
  name: string;
  status: DeliveryStatus;
  error?: string;
}

interface LarkSendResult {
  status: 'SENT' | 'ERROR';
  error?: string;
}

const NOTIFICATION_TYPE = 'new_product_price';

/** Người nhận: bỏ trùng và bỏ người đang thao tác (không tự báo cho mình). */
export function resolveRecipients(
  intended: number[],
  actorId: number | null | undefined,
): number[] {
  return [...new Set(intended)].filter((id) => id && id !== actorId);
}

/**
 * Link phiếu trên POS. `open` = tin cần người nhận làm việc → trang mở sẵn
 * modal thao tác chính (Xử lý bước / Duyệt) nếu người xem có quyền.
 */
export function nppTicketPath(code: string, open = false): string {
  return `${FRONTEND_PATH}?Code=${encodeURIComponent(code)}${open ? '&open=1' : ''}`;
}

/** Gửi thông báo trong app + tin Lark riêng (open_id = users.lark_user_id). */
@Injectable()
export class NewProductPriceNotifyService {
  private readonly logger = new Logger(NewProductPriceNotifyService.name);

  /** Gửi vào nhóm theo thứ tự từng phiếu: bước sau phải thấy chủ đề bước trước vừa mở. */
  private readonly topicQueue = new Map<number, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly nppConfig: NewProductPriceConfigService,
    @Optional() @Inject(LARK_CLIENT) private readonly larkClient?: lark.Client,
  ) {}

  private base(): string {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
  }

  ticketPath(code: string, open = false): string {
    return nppTicketPath(code, open);
  }

  /** Không chờ kết quả — lỗi gửi tin không làm hỏng thao tác chính. */
  send(kind: NppNotifyKind, ticketId: number, ctx: NotifyContext = {}): void {
    void this.notify(kind, ticketId, ctx).catch((err) =>
      this.logger.error(
        `Gửi thông báo ${kind} phiếu #${ticketId} lỗi: ${err?.message}`,
      ),
    );
  }

  async notify(kind: NppNotifyKind, ticketId: number, ctx: NotifyContext = {}) {
    const ticket = await this.prisma.newProductPriceTicket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) return;
    const cfg = await this.nppConfig.get();
    const group = (g: NppGroup) => cfg.approvers[g] ?? [];

    let primary: number[] = [];
    let extra: number[] = [];
    switch (kind) {
      case 'ENTER_PURCHASING':
      case 'SENT_BACK':
        primary = group(NPP_GROUP.PURCHASING);
        if (ticket.costApproverId) extra = [ticket.costApproverId];
        break;
      case 'ENTER_ACCOUNTING':
      case 'KTT_DECIDED':
        primary = group(NPP_GROUP.ACCOUNTING);
        break;
      case 'KTT_REQUEST':
        primary = group(NPP_GROUP.CHIEF_ACCOUNTANT);
        break;
      case 'ENTER_CEO':
        primary = group(NPP_GROUP.CEO);
        break;
      case 'TO_DATA':
        primary = group(NPP_GROUP.DATA);
        break;
      case 'CEO_REJECTED':
        primary = ticket.createdById ? [ticket.createdById] : [];
        extra = group(NPP_GROUP.PURCHASING);
        break;
      case 'PRODUCT_CREATED':
        primary = ticket.createdById ? [ticket.createdById] : [];
        break;
    }

    // Người phụ trách bước mới (thứ tự: nhóm chính trước). Tin riêng bỏ người vừa
    // thao tác; chủ đề nhóm tag đủ người phụ trách (chuẩn chung lark-sync/lark-topic.ts).
    const owners = [...new Set([...primary, ...extra])].filter(Boolean);
    const sendTo = resolveRecipients(owners, ctx.actorId);
    const lookup = [
      ...new Set([...owners, ...(ctx.actorId ? [ctx.actorId] : [])]),
    ];
    const found = lookup.length
      ? await this.prisma.user.findMany({
          where: { id: { in: lookup }, isActive: true },
          select: { id: true, name: true, larkUserId: true },
        })
      : [];
    const byId = new Map(found.map((u) => [u.id, u]));
    const ownerUsers = owners.flatMap((id) => byId.get(id) ?? []);
    const users = ownerUsers.filter((u) => sendTo.includes(u.id));
    const actorName = ctx.actorId
      ? (byId.get(ctx.actorId)?.name ?? null)
      : null;
    const greetingNames = users
      .filter((u) => primary.includes(u.id))
      .map((u) => u.name);

    // Tin báo "đã tạo sản phẩm" chỉ để xem; các tin khác cần người nhận làm việc
    const path = this.ticketPath(ticket.code, kind !== 'PRODUCT_CREATED');
    const link = `${this.base()}${path}`;
    const built = buildTicketCard(kind, ticket, {
      link,
      greetingNames,
      reason: ctx.reason,
      decision: ctx.decision,
      decidedByName: ctx.decidedByName,
      ended: ctx.ended,
      manufactured: isManufactured(ticket),
    });

    const deliveries = await this.deliver(users, built, {
      link: path,
      dedupeKey: `${kind}_${ticket.id}_${Date.now()}`,
    });

    // Nhóm Lark dạng chủ đề: song song với tin riêng, tag người phụ trách bước.
    const chatId = cfg.larkChatId;
    await this.serial(ticket.id, async () => {
      const group = chatId
        ? await postToTopic(this.larkClient, {
            chatId,
            existingRootId: await this.findTopicRoot(ticket.id, chatId),
            rootCard: buildTopicRootCard(
              ticket,
              `${this.base()}${this.ticketPath(ticket.code)}`,
            ),
            replyPost: buildTopicReply(kind, built, {
              link,
              mentions: ownerUsers.map((u) => ({
                name: u.name,
                openId: u.larkUserId,
              })),
              actorName,
              reason: ctx.reason,
              decision: ctx.decision,
              decidedByName: ctx.decidedByName,
              ended: ctx.ended,
              manufactured: isManufactured(ticket),
              productCode: ticket.productCode,
            }),
            mentioned: ownerUsers.map((u) => u.name),
            onRootBroken: (rootId, err) =>
              this.logger.warn(
                `Chủ đề ${rootId} của phiếu ${ticket.code} không dùng được (${err.message}) → mở chủ đề mới`,
              ),
          })
        : undefined;
      await this.prisma.newProductPriceEvent.create({
        data: {
          ticketId: ticket.id,
          type: NPP_EVENT.NOTIFY,
          content: built.title,
          data: {
            kind,
            recipients: deliveries,
            ...(group ? { group } : {}),
          } as any,
        },
      });
    });
  }

  /** Chạy lần lượt theo phiếu (event ghi chủ đề xong mới tới lượt sau). */
  private serial<T>(ticketId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.topicQueue.get(ticketId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.topicQueue.set(ticketId, next);
    const cleanup = () => {
      if (this.topicQueue.get(ticketId) === next)
        this.topicQueue.delete(ticketId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  /** Tin mở chủ đề của phiếu trong nhóm (đọc từ lịch sử gửi). */
  private async findTopicRoot(
    ticketId: number,
    chatId: string,
  ): Promise<string | null> {
    const events = await this.prisma.newProductPriceEvent.findMany({
      where: {
        ticketId,
        type: NPP_EVENT.NOTIFY,
        data: { path: ['group', 'chatId'], equals: chatId },
      },
      select: { data: true },
      orderBy: { id: 'asc' },
    });
    return pickTopicRoot(events, chatId);
  }

  /** Nhắc việc hằng ngày của một bước tới danh sách người nhận. */
  async sendReminder(
    stage: NppStage,
    userIds: number[],
    items: ReminderItem[],
    dateKey: string,
  ) {
    const sendTo = resolveRecipients(userIds, null);
    if (!items.length || !sendTo.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: sendTo }, isActive: true },
      select: { id: true, name: true, larkUserId: true },
    });
    const listPath = `${FRONTEND_PATH}?stage=${stage}`;
    const built = buildReminderCard(
      stage,
      items,
      `${this.base()}${listPath}`,
      users.map((u) => u.name),
    );
    return this.deliver(users, built, {
      link: listPath,
      dedupeKey: `reminder_${stage}_${dateKey}`,
    });
  }

  private async deliver(
    users: { id: number; name: string; larkUserId: string | null }[],
    built: BuiltCard,
    opts: { link: string; dedupeKey: string },
  ): Promise<Delivery[]> {
    if (!users.length) return [];
    await this.notifications
      .createForUsers(
        users.map((u) => u.id),
        {
          type: NOTIFICATION_TYPE,
          title: built.title,
          body: built.body,
          link: opts.link,
          dedupeKey: opts.dedupeKey,
        },
      )
      .catch((err) =>
        this.logger.warn(`Thông báo trong app lỗi: ${err?.message}`),
      );

    return Promise.all(
      users.map(async (u): Promise<Delivery> => {
        if (!u.larkUserId)
          return { userId: u.id, name: u.name, status: 'NO_LARK' };
        const { status, error } = await this.sendLark(
          'open_id',
          u.larkUserId,
          'interactive',
          built.card,
        );
        return {
          userId: u.id,
          name: u.name,
          status,
          ...(error ? { error } : {}),
        };
      }),
    );
  }

  private async sendLark(
    receiveIdType: 'open_id' | 'chat_id',
    receiveId: string,
    msgType: 'interactive' | 'post',
    content: Record<string, unknown>,
  ): Promise<LarkSendResult> {
    if (!this.larkClient)
      return { status: 'ERROR', error: 'Chưa cấu hình Lark' };
    return this.larkCall(() =>
      this.larkClient!.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: msgType,
          content: JSON.stringify(content),
        },
      }),
    );
  }

  private async larkCall(
    call: () => Promise<{
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    }>,
  ): Promise<LarkSendResult> {
    try {
      const response = await call();
      if (response?.code && response.code !== 0) {
        return {
          status: 'ERROR',
          error: `Lark ${response.code}: ${response.msg || ''}`.trim(),
        };
      }
      return { status: 'SENT' };
    } catch (err: any) {
      return {
        status: 'ERROR',
        error: String(err?.message || err).slice(0, 300),
      };
    }
  }
}
