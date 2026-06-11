import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UploadSessionService } from './upload-session.service';

@Injectable()
export class UploadSessionCleanup {
  private readonly logger = new Logger(UploadSessionCleanup.name);

  constructor(private readonly service: UploadSessionService) {}

  // Mỗi 10 phút đánh dấu các phiên hết hạn thành "closed".
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCleanup() {
    try {
      const count = await this.service.cleanupExpired();
      if (count > 0) {
        this.logger.log(`Đã đóng ${count} phiên upload hết hạn`);
      }
    } catch (err) {
      this.logger.error(`Cleanup phiên upload lỗi: ${(err as Error).message}`);
    }
  }
}
