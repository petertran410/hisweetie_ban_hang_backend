import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublicApiService } from './public-api.service';
import { RegisterWebhookDto } from './dto/register-webhook.dto';

/** KiotViet yêu cầu endpoint của đối tác phản hồi trong 5 giây. */
const DELIVERY_TIMEOUT_MS = 5000;
/** Số bản ghi tối đa gửi trong một lần bắn, tránh payload khổng lồ. */
const MAX_ITEMS_PER_DELIVERY = 100;
/** Ngưng gọi sau ngần này lần lỗi liên tiếp để không bắn mãi vào endpoint chết. */
const MAX_FAILURES_BEFORE_PAUSE = 10;

@Injectable()
export class PublicApiWebhookService {
  private readonly logger = new Logger(PublicApiWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApiService: PublicApiService,
  ) {}

  async register(clientId: string, dto: RegisterWebhookDto) {
    const resource = this.publicApiService.assertResource(dto.resource);
    const webhook = await this.prisma.publicApiWebhook.upsert({
      where: { clientId_resource_url: { clientId, resource, url: dto.url } },
      create: {
        clientId,
        resource,
        url: dto.url,
        secret: dto.secret,
        description: dto.description,
        isActive: dto.isActive ?? true,
        // Mốc quét bắt đầu từ lúc đăng ký: không dội lại toàn bộ lịch sử cho
        // đối tác vừa kết nối.
        cursorAt: new Date(),
      },
      update: {
        secret: dto.secret,
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
    const webhooks = await this.prisma.publicApiWebhook.findMany({
      where: {
        isActive: true,
        failureCount: { lt: MAX_FAILURES_BEFORE_PAUSE },
      },
    });
    for (const webhook of webhooks) {
      try {
        await this.dispatchOne(webhook);
      } catch (error) {
        this.logger.error(
          `Webhook ${webhook.id} thất bại: ${(error as Error).message}`,
        );
      }
    }
  }

  private async dispatchOne(webhook: {
    id: string;
    resource: string;
    url: string;
    secret: string | null;
    cursorAt: Date | null;
  }) {
    // Chốt mốc trên theo giờ máy chủ trước khi đọc: bản ghi được sửa trong lúc
    // đang gửi sẽ thuộc về lần quét sau, không bị bỏ sót.
    const until = new Date();
    const since = webhook.cursorAt ?? new Date(0);
    if (since >= until) return;

    const page = await this.publicApiService.list(
      webhook.resource as never,
      {
        lastModifiedFrom: since.toISOString(),
        lastModifiedTo: until.toISOString(),
        pageSize: MAX_ITEMS_PER_DELIVERY,
        currentItem: 0,
        includeInactive: true,
      } as never,
    );

    if (!page.data.length) {
      await this.prisma.publicApiWebhook.update({
        where: { id: webhook.id },
        data: { cursorAt: until },
      });
      return;
    }

    const payload = {
      resource: webhook.resource,
      total: page.total,
      data: page.data,
      timestamp: until.toISOString(),
    };

    const result = await this.send(webhook.url, webhook.secret, payload);

    await this.prisma.publicApiWebhookDelivery.create({
      data: {
        webhookId: webhook.id,
        resource: webhook.resource,
        payload: payload as never,
        statusCode: result.statusCode,
        success: result.success,
        errorMessage: result.error,
      },
    });

    if (result.success) {
      // Chỉ tiến mốc khi đối tác đã nhận: nếu gọi hỏng mà vẫn tiến thì lô dữ
      // liệu đó mất vĩnh viễn, lần quét sau không lấy lại được.
      await this.prisma.publicApiWebhook.update({
        where: { id: webhook.id },
        data: {
          cursorAt: until,
          failureCount: 0,
          lastStatus: result.statusCode,
          lastError: null,
          lastSuccessAt: new Date(),
        },
      });
    } else {
      await this.prisma.publicApiWebhook.update({
        where: { id: webhook.id },
        data: {
          failureCount: { increment: 1 },
          lastStatus: result.statusCode,
          lastError: result.error,
        },
      });
    }
  }

  private async send(url: string, secret: string | null, payload: unknown) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      // Chữ ký để đối tác xác minh tin đến thật sự từ POS.
      headers['X-Webhook-Signature'] = createHmac('sha256', secret)
        .update(body)
        .digest('hex');
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
    const { secret, clientId, ...rest } = webhook;
    return { ...rest, hasSecret: Boolean(secret) };
  }
}
