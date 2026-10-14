import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { LARK_CLIENT } from '../lark-client.provider';

const SOURCE_LABELS: Record<string, string> = {
  PACKING_SLIP: 'Báo đơn giao hàng',
  MANUAL_EXPENSE: 'Phiếu chi thủ công',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
};

// Phiếu chuyển từ hệ thống cũ gọi tên theo loại khoản, như giao diện POS.
const CATEGORY_LABELS: Record<string, string> = {
  DELIVERY_FEE: 'Báo đơn giao hàng',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
  OTHER_EXPENSE: 'Phiếu chi kho',
};

export interface ExpenseReviewMessage {
  larkUserId: string;
  entry: {
    code: string;
    branchName: string;
    occurredAt: Date;
    sourceType: string;
    category: string;
    description: string | null;
    expenseItem: string | null;
    amount: number;
    payerName: string | null;
    managerChecked: boolean;
    accountantChecked: boolean;
    cashIssued: boolean;
    packingSlipCode?: string | null;
  };
  note: string;
  authorName: string;
}

/** Tin Lark gửi riêng người được tag xem lại một phiếu chi kho. */
@Injectable()
export class LarkExpenseReviewNotificationService {
  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly config: ConfigService,
  ) {}

  private base() {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
  }

  entryLink(code: string) {
    return `${this.base()}/tai-chinh/phieu-chi-kho?Code=${encodeURIComponent(code)}`;
  }

  /** Nơi sửa chứng từ của phiếu (báo đơn / xe cộ); phiếu tay sửa ngay tại phiếu chi. */
  sourceLink(entry: ExpenseReviewMessage['entry']) {
    if (entry.packingSlipCode) {
      return {
        label: 'Sửa ở Báo đơn',
        url: `${this.base()}/don-hang/bao-don?Code=${encodeURIComponent(entry.packingSlipCode)}`,
      };
    }
    if (['FUEL', 'VEHICLE_CARE'].includes(entry.sourceType)) {
      return {
        label: 'Sửa ở Xe cộ',
        url: `${this.base()}/tai-chinh/xe-co?Code=${encodeURIComponent(entry.code)}&kind=${entry.sourceType}`,
      };
    }
    return null;
  }

  async send(message: ExpenseReviewMessage): Promise<void> {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: message.larkUserId,
        msg_type: 'interactive',
        content: JSON.stringify(this.buildCard(message)),
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(
        `Lark ${response.code}: ${response.msg || 'unknown error'}`,
      );
    }
  }

  buildCard({ entry, note, authorName }: ExpenseReviewMessage) {
    const link = this.entryLink(entry.code);
    const source = this.sourceLink(entry);
    const tick = (value: boolean) => (value ? '✅' : '⬜');
    const lines = [
      `**Mã phiếu:** [${entry.code}](${link})`,
      `**Chi nhánh:** ${entry.branchName}`,
      `**Ngày chi:** ${entry.occurredAt.toLocaleDateString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
      })}`,
      `**Nguồn:** ${
        SOURCE_LABELS[entry.sourceType] ||
        CATEGORY_LABELS[entry.category] ||
        'Phiếu chi kho'
      }`,
      `**Nội dung:** ${entry.description || '—'}`,
      `**Hạng mục:** ${entry.expenseItem || '—'}`,
      `**Số tiền:** ${Math.round(entry.amount).toLocaleString('vi-VN')} đ`,
      `**Người chi:** ${entry.payerName || '—'}`,
      `**Quản lý kho:** ${tick(entry.managerChecked)}   **Kế toán kho:** ${tick(
        entry.accountantChecked,
      )}   **Đã chi:** ${tick(entry.cashIssued)}`,
    ];
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Yêu cầu xem lại phiếu chi kho' },
        template: 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**Ghi chú của ${authorName}:**\n${note}`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Mở phiếu chi' },
              type: 'primary',
              url: link,
            },
            ...(source
              ? [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: source.label },
                    type: 'default',
                    url: source.url,
                  },
                ]
              : []),
          ],
        },
      ],
    };
  }
}
