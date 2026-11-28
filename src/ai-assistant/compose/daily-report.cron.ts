import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DailyReportService } from './daily-report.service';

/**
 * 17:01 hằng ngày gửi báo cáo chat cuối ngày vào nhóm Lark. Chỉ chạy khi
 * AI_DAILY_REPORT_ENABLED=true (bật sau khi duyệt bản xem trước).
 */
@Injectable()
export class DailyReportCron {
  private readonly logger = new Logger(DailyReportCron.name);
  private running = false;

  constructor(private readonly report: DailyReportService) {}

  @Cron('1 17 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handle() {
    if (process.env.AI_DAILY_REPORT_ENABLED !== 'true' || this.running) return;
    this.running = true;
    try {
      const result = await this.report.send();
      this.logger.log(
        result.sent
          ? 'Đã gửi báo cáo chat cuối ngày vào Lark'
          : `Bỏ qua: ${result.reason}`,
      );
    } catch (error) {
      this.logger.error(`Báo cáo chat cuối ngày lỗi: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
