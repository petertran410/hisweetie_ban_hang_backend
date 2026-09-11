import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

@Injectable()
export class PublicApiOutboxService {
  private readonly logger = new Logger(PublicApiOutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Đưa sự kiện miền vào outbox.
   * Chạy an toàn: nếu bảng outbox chưa được tạo trong DB thì không làm hỏng luồng nghiệp vụ.
   */
  async enqueue(
    resource: string,
    eventType: string,
    aggregateId: number,
    payload: unknown,
    tx?: any,
  ): Promise<string | null> {
    const db = tx ?? this.prisma;
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;

    try {
      if (!db.publicApiEventOutbox) return null;
      await db.publicApiEventOutbox.create({
        data: {
          eventId,
          resource,
          eventType,
          aggregateId,
          payload: payload as any,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      });
      return eventId;
    } catch (error: any) {
      this.logger.warn(
        `Không thể lưu outbox event (${resource}.${eventType}): ${error.message}`,
      );
      return null;
    }
  }
}
