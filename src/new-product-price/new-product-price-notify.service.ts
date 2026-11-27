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
} from './new-product-price-lark-cards';

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

const NOTIFICATION_TYPE = 'new_product_price';

/**
 * Người nhận thật (bỏ người đang thao tác) và người thực sự được gửi.
 * Bật gửi thử (testRecipients khác rỗng) → chỉ gửi tới danh sách gửi thử,
 * kể cả khi người thử chính là người thao tác.
 */
export function resolveRecipients(
  intended: number[],
  actorId: number | null | undefined,
  testRecipients: number[],
): { intended: number[]; sendTo: number[]; testMode: boolean } {
  const clean = [...new Set(intended)].filter((id) => id && id !== actorId);
  if (testRecipients.length) {
    return {
      intended: clean,
      sendTo: [...new Set(testRecipients)],
      testMode: true,
    };
  }
  return { intended: clean, sendTo: clean, testMode: false };
}

/**
 * Link phiếu trên POS. `open` = tin cần người nhận làm việc → trang mở sẵn
 * modal thao tác chính (Xử lý bước / Duyệt) nếu người xem có quyền.
 */
export function nppTicketPath(code: string, open = false): string {
  return `${FRONTEND_PATH}?Code=${encodeURIComponent(code)}${open ? '&open=1' : ''}`;
}

/** Dòng ghi chú đầu tin khi gửi thử. */
export function testModeNote(intendedNames: string[]): string {
  return `🧪 **GỬI THỬ** — người nhận thật: ${
    intendedNames.length
      ? intendedNames.join(', ')
      : '(chưa cấu hình người nhận)'
  }`;
}

/** Gửi thông báo trong app + tin Lark riêng (open_id = users.lark_user_id). */
@Injectable()
export class NewProductPriceNotifyService {
  private readonly logger = new Logger(NewProductPriceNotifyService.name);

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

    const target = resolveRecipients(
      [...primary, ...extra],
      ctx.actorId,
      cfg.testRecipients,
    );
    const lookup = [...new Set([...target.intended, ...target.sendTo])];
    const allUsers = lookup.length
      ? await this.prisma.user.findMany({
          where: { id: { in: lookup }, isActive: true },
          select: { id: true, name: true, larkUserId: true },
        })
      : [];
    const intendedUsers = allUsers.filter((u) =>
      target.intended.includes(u.id),
    );
    const users = allUsers.filter((u) => target.sendTo.includes(u.id));
    const greetingNames = intendedUsers
      .filter((u) => primary.includes(u.id))
      .map((u) => u.name);

    // Tin báo "đã tạo sản phẩm" chỉ để xem; các tin khác cần người nhận làm việc
    const path = this.ticketPath(ticket.code, kind !== 'PRODUCT_CREATED');
    const built = buildTicketCard(kind, ticket, {
      link: `${this.base()}${path}`,
      greetingNames,
      reason: ctx.reason,
      decision: ctx.decision,
      decidedByName: ctx.decidedByName,
      ended: ctx.ended,
      manufactured: isManufactured(ticket),
      testNote: target.testMode
        ? testModeNote(intendedUsers.map((u) => u.name))
        : null,
    });

    const deliveries = await this.deliver(users, built, {
      link: path,
      dedupeKey: `${kind}_${ticket.id}_${Date.now()}`,
    });

    let chat:
      | { chatId: string; status: DeliveryStatus; error?: string }
      | undefined;
    // Gửi thử không bao giờ gửi vào nhóm chat.
    if (kind === 'KTT_REQUEST' && cfg.larkChatId && !target.testMode) {
      const res = await this.sendLark('chat_id', cfg.larkChatId, built.card);
      chat = { chatId: cfg.larkChatId, ...res };
    }

    await this.prisma.newProductPriceEvent.create({
      data: {
        ticketId: ticket.id,
        type: NPP_EVENT.NOTIFY,
        content: built.title,
        data: {
          kind,
          recipients: deliveries,
          ...(target.testMode
            ? {
                testMode: true,
                intended: intendedUsers.map((u) => ({
                  userId: u.id,
                  name: u.name,
                })),
              }
            : {}),
          ...(chat ? { chat } : {}),
        } as any,
      },
    });
  }

  /** Nhắc việc hằng ngày của một bước tới danh sách người nhận. */
  async sendReminder(
    stage: NppStage,
    userIds: number[],
    items: ReminderItem[],
    dateKey: string,
    testRecipients: number[] = [],
  ) {
    const target = resolveRecipients(userIds, null, testRecipients);
    if (!items.length || !target.sendTo.length) return [];
    const lookup = [...new Set([...target.intended, ...target.sendTo])];
    const allUsers = await this.prisma.user.findMany({
      where: { id: { in: lookup }, isActive: true },
      select: { id: true, name: true, larkUserId: true },
    });
    const intendedUsers = allUsers.filter((u) =>
      target.intended.includes(u.id),
    );
    const users = allUsers.filter((u) => target.sendTo.includes(u.id));
    const listPath = `${FRONTEND_PATH}?stage=${stage}`;
    const built = buildReminderCard(
      stage,
      items,
      `${this.base()}${listPath}`,
      intendedUsers.map((u) => u.name),
      target.testMode ? testModeNote(intendedUsers.map((u) => u.name)) : null,
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
        const res = await this.sendLark('open_id', u.larkUserId, built.card);
        return { userId: u.id, name: u.name, ...res };
      }),
    );
  }

  private async sendLark(
    receiveIdType: 'open_id' | 'chat_id',
    receiveId: string,
    card: Record<string, unknown>,
  ): Promise<{ status: DeliveryStatus; error?: string }> {
    if (!this.larkClient)
      return { status: 'ERROR', error: 'Chưa cấu hình Lark' };
    try {
      const response = await this.larkClient.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
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
