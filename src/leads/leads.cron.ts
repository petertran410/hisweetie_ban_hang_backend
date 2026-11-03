import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeadsService } from './leads.service';

/**
 * Mỗi 15 phút: tự gắn lead với khách (trùng ID Zalo / hội thoại / SĐT), khách đã gắn có đơn đặt
 * hàng đầu → "Đã chuyển đổi"; lead chưa có Sale PIC mà đã gắn khách → lấy Sale PIC của khách.
 */
@Injectable()
export class LeadsCron {
  private readonly logger = new Logger(LeadsCron.name);
  private running = false;

  constructor(private readonly leads: LeadsService) {}

  @Cron('*/15 * * * *')
  async autoConvert() {
    if (this.running) return;
    this.running = true;
    try {
      const { checked, linked, converted } = await this.leads.autoConvert();
      if (linked || converted)
        this.logger.log(
          `Tự gắn ${linked}/${checked} lead, chuyển đổi ${converted} lead`,
        );
      const sale = await this.leads.syncSalePicFromCustomers();
      if (sale.updated)
        this.logger.log(`Lấy Sale PIC từ khách cho ${sale.updated} lead`);
    } catch (e) {
      this.logger.error(`Tự chuyển đổi lead lỗi: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
