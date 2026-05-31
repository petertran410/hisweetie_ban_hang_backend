import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-client.provider';
import { ORDER_STATUS } from '../../orders/dto/order-status.constants';

/**
 * Gửi card "ĐƠN HÀNG ĐÃ ĐƯỢC CHỐT" vào Lark group khi order chuyển sang
 * trạng thái "Đã xác nhận" (status = 5).
 *
 * Mapping branch → group (config qua env):
 *   - LARK_CONFIRMED_CHAT_ID_HN  ← branchId = 6
 *   - LARK_CONFIRMED_CHAT_ID_SG  ← branchId = 1
 *
 * Branch khác: skip silently.
 */
@Injectable()
export class LarkOrderNotificationService {
  private readonly logger = new Logger(LarkOrderNotificationService.name);

  // Map branchId → env var name
  private readonly BRANCH_CHAT_ENV: Record<number, string> = {
    6: 'LARK_CONFIRMED_CHAT_ID_HN',
    1: 'LARK_CONFIRMED_CHAT_ID_SG',
  };

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Fire-and-forget — không throw, không block caller.
   */
  notifyOrderConfirmedAsync(orderId: number): void {
    this.notifyOrderConfirmed(orderId).catch((err) => {
      this.logger.error(
        `notifyOrderConfirmed #${orderId} unexpected error: ${err?.message || err}`,
      );
    });
  }

  async notifyOrderConfirmed(orderId: number): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        branch: { select: { id: true, name: true } },
        soldBy: { select: { name: true } },
        customer: {
          include: {
            addresses: {
              orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
              take: 1,
            },
          },
        },
        items: {
          include: { product: { select: { name: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!order) {
      this.logger.warn(`Order #${orderId} not found, skip notification`);
      return;
    }

    if (order.status !== ORDER_STATUS.CONFIRMED) {
      this.logger.debug(
        `Order ${order.code} status=${order.status} (not CONFIRMED), skip`,
      );
      return;
    }

    const branchId = order.branchId;
    if (!branchId || !(branchId in this.BRANCH_CHAT_ENV)) {
      this.logger.debug(
        `Order ${order.code} branchId=${branchId} không thuộc HN(6)/SG(1), skip`,
      );
      return;
    }

    const envKey = this.BRANCH_CHAT_ENV[branchId];
    const chatId = this.config.get<string>(envKey);
    if (!chatId) {
      this.logger.warn(
        `Env ${envKey} chưa cấu hình, không gửi notification cho order ${order.code}`,
      );
      return;
    }

    const card = this.buildCard(order);

    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      if (res?.code && res.code !== 0) {
        this.logger.error(
          `Lark IM API error code=${res.code} msg=${res.msg} order=${order.code} chat=${chatId}`,
        );
        return;
      }

      this.logger.log(
        `📨 Sent confirmed-card for order ${order.code} → ${envKey} (${chatId})`,
      );
    } catch (error: any) {
      this.logger.error(
        `Send confirmed-card order ${order.code} failed: ${error?.message || error}`,
      );
    }
  }

  // =============================================
  // CARD BUILDER
  // =============================================

  private buildCard(order: any): Record<string, any> {
    const branchName = this.formatBranchName(order.branch?.name);
    const orderCode = order.code || '';
    const dateStr = this.formatDateTime(order.orderDate);
    const customerLine = this.formatCustomer(order.customer);
    const addressLine = this.formatAddress(order.customer);
    const sellerName = order.soldBy?.name || '';
    const note = (order.description || '').trim();
    const orderUrl =
      this.config.get<string>('POS_FRONTEND_URL') || 'http://localhost:3050';

    // Header block: thông tin đơn hàng
    const headerLines: string[] = [
      `**Chi nhánh:** ${branchName}`,
      `**Mã đơn hàng:** [${orderCode}](${orderUrl}/don-hang/dat-hang?Code=${encodeURIComponent(orderCode)})`,
      `**Ngày:** ${dateStr}`,
      `**Khách hàng:** ${customerLine}`,
      `**Địa chỉ:** ${addressLine}`,
      `**Nhân viên:** ${sellerName}`,
    ];
    if (note) {
      headerLines.push(`**Ghi Chú:** ${note}`);
    }

    // Items table: mỗi row là 1 column_set độc lập để 3 cột align theo hàng
    // (nếu gom thành 3 list elements riêng thì các cell ngắn sẽ bị dồn lên trên)
    const buildRow = (
      priceContent: string,
      qtyContent: string,
      totalContent: string,
      isHeader = false,
    ) => {
      const cellBg = isHeader ? 'grey' : undefined;
      const makeCol = (weight: number, content: string) => ({
        tag: 'column',
        width: 'weighted',
        weight,
        vertical_align: 'top',
        ...(cellBg ? { background_style: cellBg } : {}),
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content },
          },
        ],
      });

      return {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        ...(cellBg ? { background_style: cellBg } : {}),
        columns: [
          makeCol(3, priceContent),
          makeCol(1, qtyContent),
          makeCol(2, totalContent),
        ],
      };
    };

    const itemRows: any[] = [];
    // Header row (in đậm + nền xám nhạt)
    itemRows.push(buildRow('**Đơn giá**', '**SL**', '**T.Tiền**', true));

    for (const item of order.items || []) {
      const productName = item.product?.name || item.productName || '';
      const priceStr = this.formatMoney(item.appliedPrice ?? item.price);
      const itemNote = (item.note || '').trim();
      const qtyStr = this.formatNumber(item.quantity);
      const totalStr = this.formatMoney(item.totalPrice);

      const priceCellLines = [productName, priceStr];
      if (itemNote) priceCellLines.push(`*${itemNote}*`);

      itemRows.push(
        buildRow(priceCellLines.join('\n'), qtyStr, totalStr),
      );
    }

    // Footer: tổng kết
    const footerLines: string[] = [
      `**Tổng tiền hàng:** ${this.formatMoney(order.totalAmount)}`,
      `**Chiết khấu:** ${this.formatMoney(order.discount)}`,
      `**Tổng thanh toán:** ${this.formatMoney(order.grandTotal)}`,
      '',
      'Cảm ơn và hẹn gặp lại!',
      '',
      '**🔥 BỘ PHẬN KHO XỬ LÝ ĐƠN HÀNG NGAY NHÉ! 🔥**',
    ];

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'ĐƠN HÀNG ĐÃ ĐƯỢC CHỐT' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: headerLines.join('\n') },
        },
        { tag: 'hr' },
        ...itemRows,
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: footerLines.join('\n') },
        },
      ],
    };
  }

  private formatBranchName(name?: string | null): string {
    if (!name) return '';
    const trimmed = name.trim();
    if (/^kho\s/i.test(trimmed)) return trimmed;
    return `Kho ${trimmed}`;
  }

  private formatCustomer(customer: any): string {
    if (!customer) return '';
    const code = customer.code || '';
    const name = customer.name || '';
    const phone = customer.contactNumber || customer.phone || '';
    const parts = [code, name].filter(Boolean).join(' - ');
    return phone ? `${parts} - ${phone}` : parts;
  }

  private formatAddress(customer: any): string {
    if (!customer) return '';
    const addr = customer.addresses?.[0];
    if (!addr) return '';

    // Format: <chi tiết> - <phường/xã> - <tỉnh/TP> - <quận/huyện>
    const detail = (addr.address || '').trim();
    const ward = (addr.newWardName || addr.wardName || '').trim();
    const city = (addr.newCityName || addr.cityName || '').trim();
    const district = (addr.districtName || '').trim();

    return [detail, ward, city, district].filter(Boolean).join(' - ');
  }

  private formatDateTime(date: Date | null | undefined): string {
    if (!date) return '';
    const d = new Date(date);
    // Asia/Ho_Chi_Minh
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value || '';
    return `${get('hour')}:${get('minute')}:${get('second')} ${get('day')}/${get('month')}/${get('year')}`;
  }

  private formatMoney(value: any): string {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  private formatNumber(value: any): string {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n)
      ? String(n)
      : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
}
