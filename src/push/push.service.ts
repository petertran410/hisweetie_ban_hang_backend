import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Dịch vụ đẩy thông báo của Expo (chuyển tiếp sang APNs / FCM). */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo nhận tối đa 100 thông báo mỗi lần gọi. */
const EXPO_BATCH = 100;
const TIMEOUT_MS = 10_000;

export interface PushMessage {
  userId: number;
  title: string;
  body: string;
  /** Dữ liệu kèm theo để app mở đúng trang khi bấm vào thông báo. */
  data?: Record<string, string | number>;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string | number>;
  sound: 'default';
  priority: 'high';
  /** Kênh Android do app tạo sẵn (xem pushNotifications.ts bên mobile). */
  channelId: 'default';
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /** Lưu token của điện thoại cho user đang đăng nhập (token đã có thì chuyển sang user này). */
  async register(userId: number, token: string, platform: string) {
    await this.prisma.pushDevice.upsert({
      where: { token },
      create: { token, platform, userId },
      update: { userId, platform },
    });
    return { ok: true };
  }

  /** Đăng xuất: bỏ token, chỉ xóa được token của chính mình. */
  async unregister(userId: number, token: string) {
    await this.prisma.pushDevice.deleteMany({ where: { token, userId } });
    return { ok: true };
  }

  /**
   * Gửi thông báo tới mọi điện thoại của từng user. Không bao giờ throw: lỗi
   * mạng / Expo chỉ ghi log, không làm hỏng nghiệp vụ gọi tới.
   */
  async sendToUsers(messages: PushMessage[]): Promise<void> {
    try {
      const userIds = [...new Set(messages.map((m) => m.userId))];
      if (userIds.length === 0) return;
      const devices = await this.prisma.pushDevice.findMany({
        where: { userId: { in: userIds } },
        select: { token: true, userId: true },
      });
      const expoMessages: ExpoMessage[] = [];
      for (const m of messages) {
        for (const d of devices) {
          if (d.userId !== m.userId) continue;
          expoMessages.push({
            to: d.token,
            title: m.title,
            body: m.body,
            data: m.data,
            sound: 'default',
            priority: 'high',
            channelId: 'default',
          });
        }
      }
      for (let i = 0; i < expoMessages.length; i += EXPO_BATCH) {
        await this.sendBatch(expoMessages.slice(i, i + EXPO_BATCH));
      }
    } catch (err) {
      this.logger.error(`Gửi thông báo đẩy lỗi: ${(err as Error).message}`);
    }
  }

  private async sendBatch(batch: ExpoMessage[]) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Bật "Enhanced Security for Push" trên expo.dev thì bắt buộc có token này.
    const accessToken = this.config.get<string>('EXPO_ACCESS_TOKEN');
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.error(`Expo push trả về HTTP ${res.status}`);
      return;
    }
    const json = (await res.json()) as { data?: ExpoTicket[] };
    const tickets = Array.isArray(json.data) ? json.data : [];

    // Vé trả về đúng thứ tự gửi. Máy đã gỡ app / tắt hẳn thông báo → xóa token.
    const dead: string[] = [];
    tickets.forEach((t, i) => {
      if (t.status !== 'error') return;
      if (t.details?.error === 'DeviceNotRegistered' && batch[i]) {
        dead.push(batch[i].to);
      } else {
        this.logger.warn(`Expo push lỗi: ${t.details?.error ?? t.message}`);
      }
    });
    if (dead.length > 0) {
      await this.prisma.pushDevice.deleteMany({
        where: { token: { in: dead } },
      });
    }
  }
}
