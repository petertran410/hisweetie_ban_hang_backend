import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import {
  TopicDelivery,
  pickTopicRoot,
  postToTopic,
} from '../lark-sync/lark-topic';
import {
  CostLine,
  FRONTEND_PATH,
  PC_EVENT,
  PC_GROUP,
  PcGroup,
  PcStage,
  PriceLine,
  STAGE_LABELS,
} from './price-change.constants';
import { PriceChangeConfigService } from './price-change-config.service';
import {
  BuiltCard,
  CardTicket,
  GroupReplyContext,
  PcNotifyKind,
  ReminderItem,
  buildGroupReply,
  buildReminderCard,
  buildGroupRootCard,
  buildTicketCard,
} from './price-change-lark-cards';

export interface PcNotifyContext {
  actorId?: number | null;
  reason?: string | null;
  decidedByName?: string | null;
  decidedByRole?: string | null;
  ended?: boolean;
}

type DeliveryStatus = 'SENT' | 'NO_LARK' | 'ERROR';
interface Delivery {
  userId: number;
  name: string;
  status: DeliveryStatus;
  error?: string;
}

const NOTIFICATION_TYPE = 'price_change';
/** Tin chỉ để xem (không cần người nhận làm việc) → link không mở sẵn modal. */
const VIEW_ONLY: PcNotifyKind[] = ['APPLIED'];

/** Link phiếu trên POS; `open` = mở sẵn modal thao tác chính nếu người xem có quyền. */
export function pcTicketPath(code: string, open = false): string {
  return `${FRONTEND_PATH}?Code=${encodeURIComponent(code)}${open ? '&open=1' : ''}`;
}

/**
 * Thông báo trong app + tin Lark riêng (open_id = users.lark_user_id), song song là topic
 * của phiếu trong nhóm Lark (Cấu hình duyệt → nhóm chat) tag người phụ trách từng bước.
 */
@Injectable()
export class PriceChangeNotifyService {
  private readonly logger = new Logger(PriceChangeNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly pcConfig: PriceChangeConfigService,
    @Optional() @Inject(LARK_CLIENT) private readonly larkClient?: lark.Client,
  ) {}

  private base(): string {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
  }

  /** Không chờ kết quả — lỗi gửi tin không làm hỏng thao tác chính. */
  send(kind: PcNotifyKind, ticketId: number, ctx: PcNotifyContext = {}): void {
    void this.notify(kind, ticketId, ctx).catch((err) =>
      this.logger.error(
        `Gửi thông báo ${kind} phiếu #${ticketId} lỗi: ${err?.message}`,
      ),
    );
  }

  async notify(
    kind: PcNotifyKind,
    ticketId: number,
    ctx: PcNotifyContext = {},
  ) {
    const ticket = await this.prisma.priceChangeTicket.findUnique({
      where: { id: ticketId },
      include: { items: { orderBy: { sort: 'asc' } } },
    });
    if (!ticket) return;
    const cfg = await this.pcConfig.get();
    const group = (g: PcGroup) => cfg.approvers[g] ?? [];

    let primary: number[] = [];
    switch (kind) {
      case 'TO_KTT':
        primary = group(PC_GROUP.CHIEF_ACCOUNTANT);
        break;
      case 'TO_CEO':
        primary = group(PC_GROUP.CEO);
        break;
      case 'TO_DATA':
        primary = group(PC_GROUP.DATA);
        break;
      case 'REJECTED':
      case 'SENT_BACK':
      case 'APPLIED':
        primary = ticket.createdById ? [ticket.createdById] : [];
        break;
    }

    const owners = [...new Set(primary)];
    const ownerUsers = owners.length
      ? await this.prisma.user.findMany({
          where: { id: { in: owners }, isActive: true },
          select: { id: true, name: true, larkUserId: true },
        })
      : [];
    // Tin riêng: không gửi cho chính người vừa thao tác. Topic nhóm: vẫn tag đủ người phụ trách bước.
    const users = ownerUsers.filter((u) => u.id !== ctx.actorId);

    const path = pcTicketPath(ticket.code, !VIEW_ONLY.includes(kind));
    const cardTicket: CardTicket = {
      code: ticket.code,
      createdByName: ticket.createdByName,
      createdAt: ticket.createdAt,
      note: ticket.note,
      hasCost: ticket.hasCost,
      hasSale: ticket.hasSale,
      items: ticket.items.map((i) => ({
        productCode: i.productCode,
        productName: i.productName,
        costs: (i.costs as unknown as CostLine[]) ?? [],
        prices: (i.prices as unknown as PriceLine[]) ?? [],
      })),
    };
    const built = buildTicketCard(kind, cardTicket, {
      link: `${this.base()}${path}`,
      greetingNames: users.map((u) => u.name),
      reason: ctx.reason,
      decidedByName: ctx.decidedByName,
      decidedByRole: ctx.decidedByRole,
      ended: ctx.ended,
    });

    const deliveries = await this.deliver(users, built, {
      link: path,
      dedupeKey: `pc_${kind}_${ticket.id}_${Date.now()}`,
    });

    // Luồng song song: topic của phiếu trong nhóm Lark, tag người phụ trách bước mới
    const groupPost = cfg.larkChatId
      ? await this.postToGroup(cfg.larkChatId, kind, ticket.id, cardTicket, {
          link: `${this.base()}${path}`,
          mentions: ownerUsers.map((u) => ({
            name: u.name,
            openId: u.larkUserId,
          })),
          reason: ctx.reason,
          decidedByName: ctx.decidedByName,
          decidedByRole: ctx.decidedByRole,
          ended: ctx.ended,
        })
      : null;

    await this.prisma.priceChangeEvent.create({
      data: {
        ticketId: ticket.id,
        type: PC_EVENT.NOTIFY,
        content: built.title,
        data: {
          kind,
          recipients: deliveries,
          ...(groupPost ? { group: groupPost } : {}),
        } as any,
      },
    });
  }

  /**
   * Topic của phiếu trong nhóm (tin mở đầu lưu ở `data.group` của sự kiện NOTIFY trước),
   * rồi gửi trả lời tag người phụ trách — bố cục & cách gửi chung: lark-sync/lark-topic.ts.
   */
  private async postToGroup(
    chatId: string,
    kind: PcNotifyKind,
    ticketId: number,
    t: CardTicket,
    ctx: GroupReplyContext,
  ): Promise<TopicDelivery> {
    const events = await this.prisma.priceChangeEvent.findMany({
      where: { ticketId, type: PC_EVENT.NOTIFY },
      orderBy: { createdAt: 'desc' },
      select: { data: true },
    });
    const existingRootId = pickTopicRoot(events, chatId);
    return postToTopic(this.larkClient, {
      chatId,
      existingRootId,
      rootCard: buildGroupRootCard(t, `${this.base()}${pcTicketPath(t.code)}`),
      replyPost: buildGroupReply(kind, {
        ...ctx,
        resubmit: kind === 'TO_KTT' && !!existingRootId,
      }),
      mentioned: ctx.mentions.map((m) => m.name),
      onRootBroken: (rootId, err) =>
        this.logger.warn(
          `Topic ${rootId} của phiếu #${ticketId} không dùng được (${err.message}) → tạo topic mới`,
        ),
    });
  }

  /** Nhắc việc hằng ngày của 1 bước: 1 tin tổng hợp tới người trong nhóm (tin riêng + trong app). */
  async sendReminder(
    stage: PcStage,
    userIds: number[],
    items: ReminderItem[],
    dateKey: string,
  ): Promise<Delivery[]> {
    const ids = [...new Set(userIds)];
    if (!items.length || !ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, name: true, larkUserId: true },
    });
    const listPath = `${FRONTEND_PATH}?stage=${stage}`;
    const built = buildReminderCard(
      STAGE_LABELS[stage],
      items,
      `${this.base()}${listPath}`,
      users.map((u) => u.name),
    );
    return this.deliver(users, built, {
      link: listPath,
      dedupeKey: `pc_reminder_${stage}_${dateKey}`,
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
        const res = await this.sendLark(u.larkUserId, built.card);
        return { userId: u.id, name: u.name, ...res };
      }),
    );
  }

  private async sendLark(
    openId: string,
    card: Record<string, unknown>,
  ): Promise<{ status: DeliveryStatus; error?: string }> {
    if (!this.larkClient)
      return { status: 'ERROR', error: 'Chưa cấu hình Lark' };
    try {
      const response = await this.larkClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
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
