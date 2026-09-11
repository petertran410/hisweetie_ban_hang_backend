import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublicApiService } from './public-api.service';
import { RegisterWebhookDto } from './dto/register-webhook.dto';
import {
  assertSafeWebhookUrl,
  decryptSecret,
  encryptSecret,
} from './public-api-crypto.util';

/** KiotViet yêu cầu endpoint của đối tác phản hồi trong 5 giây. */
const DELIVERY_TIMEOUT_MS = 5000;
/** Số bản ghi tối đa gửi trong một lần bắn, tránh payload khổng lồ. */
const MAX_ITEMS_PER_DELIVERY = 100;
/** Ngưng gọi sau ngần này lần lỗi liên tiếp để không bắn mãi vào endpoint chết. */
const MAX_FAILURES_BEFORE_PAUSE = 10;
/** Số batch tối đa gửi trong một chu kỳ cron để nhanh chóng bắt kịp dữ liệu mà không nghẽn tài nguyên. */
const MAX_BATCHES_PER_DISPATCH = 3;
/** Thời gian khóa tối đa trước khi instance khác có thể nhận lại webhook bị treo. */
const LEASE_MINUTES = 5;

@Injectable()
export class PublicApiWebhookService {
  private readonly logger = new Logger(PublicApiWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApiService: PublicApiService,
  ) {}

  async register(clientId: string, dto: RegisterWebhookDto) {
    await assertSafeWebhookUrl(dto.url);
    const resource = this.publicApiService.assertResource(dto.resource);
    const encryptedSecret = encryptSecret(dto.secret);
    const webhook = await this.prisma.publicApiWebhook.upsert({
      where: { clientId_resource_url: { clientId, resource, url: dto.url } },
      create: {
        clientId,
        resource,
        url: dto.url,
        secret: encryptedSecret,
        description: dto.description,
        isActive: dto.isActive ?? true,
        // Mốc quét bắt đầu từ lúc đăng ký: không dội lại toàn bộ lịch sử cho
        // đối tác vừa kết nối.
        cursorAt: new Date(),
        cursorId: null,
      },
      update: {
        secret: encryptedSecret,
        description: dto.description,
        isActive: dto.isActive ?? true,
        failureCount: 0,
        lastError: null,
      },
    });
    return {
      data: this.toPublicShape(webhook),
      timestamp: new Date().toISOString(),
    };
  }

  async retry(clientId: string, id: string) {
    const webhook = await this.prisma.publicApiWebhook.findFirst({
      where: { id, clientId },
    });
    if (!webhook) throw new NotFoundException('Resource not found');

    const updated = await this.prisma.publicApiWebhook.update({
      where: { id },
      data: {
        isActive: true,
        failureCount: 0,
        lastError: null,
      },
    });

    try {
      await this.dispatchOne(updated as any);
    } catch (error) {
      this.logger.warn(
        `Thử lại webhook ${id} thất bại: ${(error as Error).message}`,
      );
    }

    return {
      message: 'Đã kích hoạt thử lại webhook thành công',
      data: this.toPublicShape(updated),
      timestamp: new Date().toISOString(),
    };
  }
  async list(clientId: string) {
    const rows = await this.prisma.publicApiWebhook.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      total: rows.length,
      data: rows.map((row) => this.toPublicShape(row)),
      timestamp: new Date().toISOString(),
    };
  }

  async get(clientId: string, id: string) {
    const webhook = await this.prisma.publicApiWebhook.findFirst({
      where: { id, clientId },
    });
    if (!webhook) throw new NotFoundException('Resource not found');
    const deliveries = await this.prisma.publicApiWebhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        attempt: true,
        statusCode: true,
        success: true,
        errorMessage: true,
        createdAt: true,
      },
    });
    return {
      data: {
        ...this.toPublicShape(webhook),
        recentDeliveries: deliveries.map((delivery) => ({
          ...delivery,
          id: delivery.id.toString(),
        })),
      },
      timestamp: new Date().toISOString(),
    };
  }

  async unregister(clientId: string, id: string) {
    const webhook = await this.prisma.publicApiWebhook.findFirst({
      where: { id, clientId },
    });
    if (!webhook) throw new NotFoundException('Resource not found');
    await this.prisma.publicApiWebhook.delete({ where: { id } });
    return {
      message: 'Huỷ đăng ký webhook thành công',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Quét thay đổi bằng cách so `updatedAt` với mốc đã lưu của từng webhook.
   *
   * Chọn quét định kỳ thay vì chèn hook vào service nghiệp vụ để Public API
   * không phải sửa bất kỳ dòng nào trong luồng POS đang chạy. Đánh đổi là tin
   * báo trễ tối đa bằng chu kỳ chạy.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchPending() {
    const workerId = `${process.env.HOSTNAME || 'worker'}:${process.pid}`;
    const leaseCutoff = new Date(Date.now() - LEASE_MINUTES * 60 * 1000);

    const webhooks = await this.prisma.publicApiWebhook.findMany({
      where: {
        isActive: true,
        failureCount: { lt: MAX_FAILURES_BEFORE_PAUSE },
        OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCutoff } }],
      },
      take: 50,
    });
    for (const webhook of webhooks) {
      const claimed = await this.prisma.publicApiWebhook.updateMany({
        where: {
          id: webhook.id,
          isActive: true,
          OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCutoff } }],
        },
        data: {
          lockedAt: new Date(),
          lockedBy: workerId,
        },
      });
      if (claimed.count === 0) continue;

      try {
        await this.dispatchOne(webhook);
      } catch (error) {
        this.logger.error(
          `Webhook ${webhook.id} thất bại: ${(error as Error).message}`,
        );
        await this.prisma.publicApiWebhook
          .update({
            where: { id: webhook.id },
            data: { lockedAt: null, lockedBy: null },
          })
          .catch(() => undefined);
      }
    }
  }

  private async dispatchOne(webhook: {
    id: string;
    resource: string;
    url: string;
    secret: string | null;
    cursorAt: Date | null;
    cursorId?: bigint | number | null;
    failureCount?: number;
  }) {
    let currentCursorAt = webhook.cursorAt ?? new Date(0);
    let currentCursorId = webhook.cursorId ?? null;
    let batchesProcessed = 0;

    try {
      while (batchesProcessed < MAX_BATCHES_PER_DISPATCH) {
        const until = new Date();

        const page = await this.publicApiService.listKeyset(
          webhook.resource as never,
          {
            cursorAt: currentCursorAt,
            cursorId: currentCursorId,
            until,
            take: MAX_ITEMS_PER_DELIVERY,
            includeInactive: true,
          },
        );

        if (!page.data.length) {
          await this.prisma.publicApiWebhook.update({
            where: { id: webhook.id },
            data: {
              cursorAt: until,
              cursorId: null,
              lockedAt: null,
              lockedBy: null,
            },
          });
          break;
        }

        const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
        const eventType = `${webhook.resource}.sync`;

        const payload = {
          eventId,
          eventType,
          schemaVersion: '1.0',
          occurredAt: until.toISOString(),
          resource: webhook.resource,
          total: page.data.length,
          data: page.data,
          timestamp: until.toISOString(),
        };

        const plainSecret = decryptSecret(webhook.secret);
        const result = await this.send(webhook.url, plainSecret, payload, {
          eventId,
          timestamp: until.toISOString(),
        });

        await this.prisma.publicApiWebhookDelivery.create({
          data: {
            webhookId: webhook.id,
            resource: webhook.resource,
            payload: payload as never,
            statusCode: result.statusCode,
            success: result.success,
            errorMessage: result.error,
            eventId,
            eventType,
            attempt: (webhook.failureCount || 0) + 1,
          },
        });

        if (result.success) {
          currentCursorAt = page.lastCursorAt ?? until;
          currentCursorId = page.lastCursorId;
          batchesProcessed++;

          await this.prisma.publicApiWebhook.update({
            where: { id: webhook.id },
            data: {
              cursorAt: currentCursorAt,
              cursorId: currentCursorId,
              failureCount: 0,
              lastStatus: result.statusCode,
              lastError: null,
              lastSuccessAt: new Date(),
            },
          });

          if (!page.hasMore) {
            break;
          }
        } else {
          await this.prisma.publicApiWebhook.update({
            where: { id: webhook.id },
            data: {
              failureCount: { increment: 1 },
              lastStatus: result.statusCode,
              lastError: result.error,
            },
          });
          break;
        }
      }
    } finally {
      await this.prisma.publicApiWebhook
        .update({
          where: { id: webhook.id },
          data: { lockedAt: null, lockedBy: null },
        })
        .catch(() => undefined);
    }
  }

  private async send(
    url: string,
    secret: string | null,
    payload: unknown,
    meta: { eventId: string; timestamp: string },
  ) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Id': meta.eventId,
      'X-Webhook-Timestamp': meta.timestamp,
    };
    if (secret) {
      headers['X-Webhook-Signature'] = createHmac('sha256', secret)
        .update(`${meta.timestamp}.${body}`)
        .digest('hex');
    }

    try {
      await assertSafeWebhookUrl(url);
    } catch (error: any) {
      return {
        success: false,
        statusCode: 400,
        error: `SSRF_BLOCKED: ${error.message}`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      return {
        success: response.ok,
        statusCode: response.status,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      const message =
        (error as Error).name === 'AbortError'
          ? `Không phản hồi trong ${DELIVERY_TIMEOUT_MS}ms`
          : (error as Error).message;
      return { success: false, statusCode: undefined, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private toPublicShape(webhook: Record<string, any>) {
    // Không trả `secret` ra ngoài: đối tác đã có bản của mình khi đăng ký.
    const { secret, clientId, lockedAt, lockedBy, cursorId, ...rest } = webhook;
    return { ...rest, hasSecret: Boolean(secret) };
  }
}
