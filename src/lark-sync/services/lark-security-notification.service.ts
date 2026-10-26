import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-client.provider';
import {
  SESSION_CREATED,
  SESSION_REVOKED,
  SessionCreatedEvent,
  SessionRevokedEvent,
  sessionEvents,
} from '../../auth/session/session-events';
import { describeUserAgent } from '../../auth/session/user-agent.util';

type Alert = {
  userId: number;
  kind: 'new_device' | 'token_reuse';
  userAgent?: string | null;
  ip?: string | null;
  at: Date;
};

/**
 * Cảnh báo bảo mật qua tin nhắn Lark gửi cho CHÍNH CHỦ tài khoản:
 * - đăng nhập từ trình duyệt/thiết bị lạ;
 * - phiên bị thu hồi vì token cũ bị dùng lại (nghi bị đánh cắp).
 * Gửi lỗi chỉ ghi log — không bao giờ ảnh hưởng việc đăng nhập.
 */
@Injectable()
export class LarkSecurityNotificationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LarkSecurityNotificationService.name);

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    sessionEvents.on(SESSION_CREATED, this.onCreated);
    sessionEvents.on(SESSION_REVOKED, this.onRevoked);
  }

  onModuleDestroy() {
    sessionEvents.off(SESSION_CREATED, this.onCreated);
    sessionEvents.off(SESSION_REVOKED, this.onRevoked);
  }

  private readonly onCreated = (event: SessionCreatedEvent) => {
    if (!event.newDevice) return;
    void this.notify({
      userId: event.userId,
      kind: 'new_device',
      userAgent: event.userAgent,
      ip: event.ip,
      at: new Date(),
    });
  };

  private readonly onRevoked = (event: SessionRevokedEvent) => {
    if (event.reason !== 'reuse') return;
    for (const sessionId of event.sessionIds ?? []) {
      void this.prisma.authSession
        .findUnique({
          where: { id: sessionId },
          select: { userId: true, userAgent: true, ip: true },
        })
        .then((session) =>
          session
            ? this.notify({ ...session, kind: 'token_reuse', at: new Date() })
            : undefined,
        )
        .catch((error) =>
          this.logger.warn(
            `Token reuse alert skipped: ${(error as Error)?.message}`,
          ),
        );
    }
  };

  async notify(alert: Alert): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: alert.userId },
        select: { larkUserId: true, name: true },
      });
      if (!user?.larkUserId) return;
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: user.larkUserId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard(alert)),
        },
      });
      if (response?.code && response.code !== 0) {
        throw new Error(`Lark ${response.code}: ${response.msg || 'unknown'}`);
      }
    } catch (error) {
      this.logger.warn(
        `Security alert (${alert.kind}) for user ${alert.userId} not sent: ${(error as Error)?.message}`,
      );
    }
  }

  buildCard(alert: Alert) {
    const device = describeUserAgent(alert.userAgent);
    const when = alert.at.toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    const devicesUrl = `${(
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '')}/cai-dat/thiet-bi`;
    const reuse = alert.kind === 'token_reuse';
    const lines = [
      reuse
        ? 'Phiên đăng nhập của bạn vừa bị **dùng lại từ nơi khác** (nghi bị đánh cắp). Hệ thống đã đăng xuất phiên đó.'
        : 'Tài khoản POS của bạn vừa **đăng nhập trên một thiết bị mới**.',
      '',
      `**Thiết bị:** ${device.browser} trên ${device.os}`,
      `**IP:** ${alert.ip || 'không rõ'}`,
      `**Thời gian:** ${when}`,
      '',
      'Nếu **không phải bạn**: đổi mật khẩu ngay và đăng xuất các thiết bị lạ.',
    ];
    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: reuse
            ? 'Cảnh báo: nghi phiên đăng nhập bị đánh cắp'
            : 'Đăng nhập trên thiết bị mới',
        },
        template: reuse ? 'red' : 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Xem thiết bị đăng nhập' },
              type: 'primary',
              url: devicesUrl,
            },
          ],
        },
      ],
    };
  }
}
