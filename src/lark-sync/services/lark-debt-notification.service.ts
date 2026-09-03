import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { LARK_CLIENT } from '../lark-client.provider';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LarkDebtNotificationService {
  private readonly logger = new Logger(LarkDebtNotificationService.name);
  private readonly branchChatEnv: Record<number, string> = {
    6: 'LARK_DEBT_CHAT_ID_HN',
    1: 'LARK_DEBT_CHAT_ID_SG',
  };

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  notifyStopDeliveryCreatedAsync(customerId: number): void {
    void this.notifyStopDeliveryCreated(customerId).catch((error) =>
      this.logger.error(
        `Gửi cảnh báo công nợ KH#${customerId} thất bại: ${error?.message || error}`,
      ),
    );
  }

  async notifyStopDeliveryCreated(customerId: number): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        code: true,
        name: true,
        totalDebt: true,
        branchId: true,
        branch: { select: { name: true } },
      },
    });
    if (!customer) return;

    const envKey = customer.branchId
      ? this.branchChatEnv[customer.branchId]
      : undefined;
    if (!envKey) {
      this.logger.warn(
        `Chưa có cấu hình group công nợ cho chi nhánh của KH ${customer.code}, bỏ qua cảnh báo`,
      );
      return;
    }
    const chatId = this.config.get<string>(envKey);
    if (!chatId) {
      this.logger.warn(
        `${envKey} chưa cấu hình, bỏ qua cảnh báo KH ${customer.code}`,
      );
      return;
    }

    const content = [
      '⚠️ **NGỪNG ĐI HÀNG DO QUÁ HẠN CÔNG NỢ**',
      `**Khách hàng:** ${customer.name} (${customer.code || `#${customer.id}`})`,
      `**Chi nhánh:** ${customer.branch?.name || '—'}`,
      `**Nợ hiện tại:** ${Math.round(Number(customer.totalDebt)).toLocaleString('vi-VN')} đ`,
      'Hệ thống đã tạo phiếu ngừng đi hàng. Chỉ mở lại khi phiếu được tự động hoàn thành do thanh toán đủ hoặc được kết thúc thủ công.',
    ].join('\n');

    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Lark ${response.code}: ${response.msg || 'unknown error'}`);
    }
  }
}
