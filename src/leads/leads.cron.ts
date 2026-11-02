import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeadsService } from './leads.service';

/**
 * Mỗi 15 phút: lead có SĐT trùng khách đã phát sinh hóa đơn → tự chuyển "Đã chuyển đổi";
 * lead chưa có Sale PIC mà đã gắn khách → lấy Sale PIC của khách.
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
      const { checked, converted } = await this.leads.autoConvert();
      if (converted)
        this.logger.log(`Tự chuyển đổi ${converted}/${checked} lead`);
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
