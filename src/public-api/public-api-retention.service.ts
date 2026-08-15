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

  private readonly auditLogRetentionDays = Number(process.env.PUBLIC_API_AUDIT_RETENTION_DAYS || 30);
  private readonly deliveryRetentionDays = Number(process.env.PUBLIC_API_DELIVERY_RETENTION_DAYS || 14);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: PublicApiIdempotencyService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredLogs() {
    const auditCutoff = this.cutoff(this.auditLogRetentionDays);
    const deliveryCutoff = this.cutoff(this.deliveryRetentionDays);

    const [audit, deliveries, idempotencyKeys] = await Promise.all([
      this.prisma.publicApiAuditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
      // Giữ lại bản ghi thất bại còn hạn retry để không mất dấu vết khi đối tác
      // báo thiếu dữ liệu.
      this.prisma.publicApiWebhookDelivery.deleteMany({
        where: { createdAt: { lt: deliveryCutoff }, success: true },
      }),
      this.idempotency.purgeExpired(),
    ]);

    if (audit.count || deliveries.count || idempotencyKeys) {
      this.logger.log(
        `Đã dọn ${audit.count} audit log, ${deliveries.count} webhook delivery và ${idempotencyKeys} idempotency key quá hạn`,
      );
    }
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
