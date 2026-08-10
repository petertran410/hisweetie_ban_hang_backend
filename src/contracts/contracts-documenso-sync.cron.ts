import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettingsService } from '../settings/settings.service';
import { ContractsService } from './contracts.service';

/**
 * Cron mỗi ngày 23h30 (UTC+7) đồng bộ lại trạng thái các HĐ đang kẹt SENT /
 * PARTIALLY_SIGNED với Documenso, phòng trường hợp webhook bị miss (Documenso
 * down, network drop, env webhook secret sai, ...). Sau đó nếu cần sẽ gửi mail
 * nhắc NV ký phần BÊN A.
 *
 * Bật/tắt qua Settings.contractDocumensoSyncCronEnabled (mặc định bật).
 */
@Injectable()
export class ContractsDocumensoSyncCron {
  private readonly logger = new Logger(ContractsDocumensoSyncCron.name);

  constructor(
    private readonly contractsService: ContractsService,
    private readonly settingsService: SettingsService,
  ) {}

  @Cron('30 23 * * *', {
    name: 'contracts-documenso-sync',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailySync() {
    const settings = await this.settingsService.getSettings();
    if (!settings.contractDocumensoSyncCronEnabled) {
      this.logger.debug('Bỏ qua cron sync Documenso (tắt trong Cài đặt)');
      return;
    }

    const candidates = await this.contractsService.findStaleForSync();
    this.logger.log(
      `Cron sync Documenso: ${candidates.length} HĐ cần kiểm tra (status SENT/PARTIALLY_SIGNED, sentAt hôm nay hoặc hôm qua, chưa có SIGNED).`,
    );

    let synced = 0;
    let stillPending = 0;
    for (const c of candidates) {
      try {
        const before = c.status;
        const after = await this.contractsService.syncFromDocumenso(c.id);
        if (after.status !== before) {
          synced++;
        } else {
          stillPending++;
        }
      } catch (err: any) {
        this.logger.error(
          `Cron sync Documenso #${c.id} lỗi: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Cron sync Documenso xong: ${synced} HĐ đổi trạng thái, ${stillPending} HĐ vẫn chờ.`,
    );
  }
}
