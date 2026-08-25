import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InventorySnapshotService } from './inventory-snapshot.service';

@Injectable()
export class InventorySnapshotCron {
  private readonly logger = new Logger(InventorySnapshotCron.name);

  constructor(private readonly service: InventorySnapshotService) {}

  /**
   * Chốt tồn kho lúc 00:15 giờ VN cho **ngày hôm trước**.
   *
   * Chạy sau nửa đêm để các phiếu phát sinh trong ngày đã ghi xong, và chốt
   * lùi một ngày để snapshot phản ánh trạng thái cuối ngày thật sự.
   */
  @Cron('15 0 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleDailySnapshot() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const result = await this.service.captureDailySnapshot(yesterday);
      this.logger.log(
        `Snapshot tồn kho ${result.date}: ghi ${result.written} bản ghi.`,
      );
    } catch (err) {
      this.logger.error(
        `Chốt snapshot tồn kho lỗi: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
