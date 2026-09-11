import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PublicApiIdempotencyService } from './public-api-idempotency.service';

/**
 * Dọn nhật ký Public API theo chu kỳ.
 *
 * `public_api_audit_logs` và `public_api_webhook_deliveries` chỉ tăng theo mỗi
 * request/lần bắn. Không dọn thì sau vài tháng chúng sẽ chiếm phần lớn dung
 * lượng cơ sở dữ liệu và làm chậm chính các truy vấn nghiệp vụ của POS.
 *
 * Chỉ đụng bảng của Public API, không chạm dữ liệu nghiệp vụ.
 */
@Injectable()
export class PublicApiRetentionService {
  private readonly logger = new Logger(PublicApiRetentionService.name);

  private readonly auditLogRetentionDays = Number(
    process.env.PUBLIC_API_AUDIT_RETENTION_DAYS || 30,
  );
  private readonly deliveryRetentionDays = Number(
    process.env.PUBLIC_API_DELIVERY_RETENTION_DAYS || 14,
  );
  private readonly failedDeliveryRetentionDays = Number(
    process.env.PUBLIC_API_FAILED_DELIVERY_RETENTION_DAYS || 60,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: PublicApiIdempotencyService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredLogs() {
    const auditCutoff = this.cutoff(this.auditLogRetentionDays);
    const deliveryCutoff = this.cutoff(this.deliveryRetentionDays);
    const failedDeliveryCutoff = this.cutoff(this.failedDeliveryRetentionDays);

    const [audit, deliveries, failedDeliveries, idempotencyKeys] =
      await Promise.all([
        this.prisma.publicApiAuditLog.deleteMany({
          where: { createdAt: { lt: auditCutoff } },
        }),
        this.prisma.publicApiWebhookDelivery.deleteMany({
          where: { createdAt: { lt: deliveryCutoff }, success: true },
        }),
        this.prisma.publicApiWebhookDelivery.deleteMany({
          where: { createdAt: { lt: failedDeliveryCutoff }, success: false },
        }),
        this.idempotency.purgeExpired(),
      ]);

    // Xóa outbox đã hoàn thành quá hạn (nếu bảng tồn tại)
    let outboxCount = 0;
    try {
      const outbox = await (
        this.prisma as any
      ).publicApiEventOutbox?.deleteMany?.({
        where: {
          createdAt: { lt: deliveryCutoff },
          status: { in: ['SENT', 'SKIPPED', 'DEAD'] },
        },
      });
      outboxCount = outbox?.count || 0;
    } catch {
      // Bỏ qua nếu bảng outbox chưa được migrate
    }

    const totalDeliveries = deliveries.count + failedDeliveries.count;
    if (audit.count || totalDeliveries || idempotencyKeys || outboxCount) {
      this.logger.log(
        `Đã dọn ${audit.count} audit log, ${totalDeliveries} webhook delivery (${deliveries.count} thành công, ${failedDeliveries.count} thất bại), ${outboxCount} outbox và ${idempotencyKeys} idempotency key quá hạn`,
      );
    }
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
