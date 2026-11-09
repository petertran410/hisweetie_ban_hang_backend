import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { LARK_CLIENT } from '../../lark-sync/lark-client.provider';

export interface CustomerDemandNotificationSnapshot {
  id: number;
  customer: { name: string };
  note?: string | null;
  months: Array<{
    id: number;
    month: string;
    status: string;
    note?: string | null;
    lines: Array<{
      product: { name: string; unit?: string | null };
      inputQuantity: number;
      inputUnit: string;
      quantityBase: number;
    }>;
  }>;
}

type DemandNotificationEvent = 'CREATED' | 'UPDATED';

@Injectable()
export class LarkCustomerDemandNotificationService {
  private readonly logger = new Logger(
    LarkCustomerDemandNotificationService.name,
  );
  private readonly quantityFormatter = new Intl.NumberFormat('vi-VN', {
    useGrouping: false,
    maximumFractionDigits: 4,
  });

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly config: ConfigService,
  ) {}

  notifyDemandSavedAsync(
    demand: CustomerDemandNotificationSnapshot,
    event: DemandNotificationEvent,
  ): void {
    void this.notifyDemandSaved(demand, event);
  }

  async notifyDemandSaved(
    demand: CustomerDemandNotificationSnapshot,
    event: DemandNotificationEvent,
  ): Promise<void> {
    try {
      const chatId = this.config
        .get<string>('LARK_DEMAND_CUSTOMER_CHAT')
        ?.trim();
      if (!chatId) {
        this.logger.warn(
          `LARK_DEMAND_CUSTOMER_CHAT chưa cấu hình, bỏ qua thông báo Demand #${demand.id}`,
        );
        return;
      }

      const months = demand.months.filter(
        (month) => month.status !== 'CANCELLED',
      );
      if (!months.length) return;

      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard({ ...demand, months }, event)),
        },
      });
      if (response?.code && response.code !== 0) {
        this.logger.warn(
          `Gửi Lark Demand #${demand.id} thất bại: code=${response.code}, msg=${response.msg}`,
        );
        return;
      }

      this.logger.log(`Đã gửi thông báo Lark Demand #${demand.id} (${event})`);
    } catch (error: unknown) {
      this.logger.warn(
        `Gửi Lark Demand #${demand.id} thất bại: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private buildCard(
    demand: CustomerDemandNotificationSnapshot,
    event: DemandNotificationEvent,
  ) {
    const elements = demand.months.flatMap((month) => {
      const [year, monthNumber] = month.month.split('-');
      const header = [
        `Demand Tháng ${monthNumber}/${year} :`,
        `Tên Khách Hàng: ${this.escapeMarkdown(demand.customer.name)}`,
      ];
      const products = month.lines.map((line, index) => {
        const baseUnit = this.escapeMarkdown(line.product.unit ?? '');
        const orderUnit = line.inputUnit === 'CARTON' ? 'Thùng' : baseUnit;
        return [
          `${index + 1}.**Tên Hàng Hóa:** ${this.escapeMarkdown(line.product.name)}`,
          `**Số lượng:** ${this.quantityFormatter.format(line.inputQuantity)}`,
          `**Đơn Vị Đặt:** ${orderUnit}`,
          `**Số lượng quy đổi:** ${this.quantityFormatter.format(line.quantityBase)}`,
          `**ĐVT:** ${baseUnit}`,
        ].join('\n');
      });
      const note = `**Ghi Chú :** ${this.escapeMarkdown(month.note ?? demand.note ?? '')}`;

      return [header.join('\n'), ...products, note].map((content) => ({
        tag: 'div',
        text: { tag: 'lark_md', content },
      }));
    });

    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'carmine',
        title: {
          tag: 'plain_text',
          content:
            event === 'CREATED'
              ? '📣 Thông Báo Demand Khách Chuỗi Mới'
              : '📣 Cập Nhật Demand Khách Chuỗi',
        },
      },
      elements,
    };
  }

  private escapeMarkdown(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[\\`*_[\]]/g, '\\$&');
  }
}
