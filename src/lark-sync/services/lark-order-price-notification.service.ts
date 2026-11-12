import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-client.provider';
import { findOrderPriceWarnings } from '../../orders/order-price-warnings.query';

const CHAT_ID = 'oc_9c5f34c588b0c08e45c0f5fe47053ffa';
const MAX_ROWS = 30;

type PriceRow = Awaited<ReturnType<typeof findOrderPriceWarnings>>[number];

/** Dấu vân tay các dòng lệch giá — sửa đơn mà lệch y như cũ thì không báo lại. */
export function orderPriceWarningSignature(rows: PriceRow[]): string {
  return JSON.stringify(
    rows.map((r) => [r.productCode, Number(r.price), Number(r.listPrice)]),
  );
}

/**
 * Gửi card cảnh báo vào nhóm Lark khi đơn đặt hàng có dòng bán thấp hơn giá bảng giá
 * buôn 2/3 (cùng điều kiện icon ⚠ trên danh sách đặt hàng). Env LARK_ORDER_PRICE_CHAT_ID
 * ghi đè nhóm nhận.
 */
@Injectable()
export class LarkOrderPriceNotificationService {
  private readonly logger = new Logger(LarkOrderPriceNotificationService.name);

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Chữ ký lệch giá hiện tại của đơn (gọi trước khi sửa để chống báo trùng). */
  async signature(orderId: number): Promise<string> {
    return orderPriceWarningSignature(
      await findOrderPriceWarnings(this.prisma, [orderId]),
    );
  }

  /** Fire-and-forget — không throw, không chặn response. */
  notifyAsync(
    orderId: number,
    opts: {
      action: 'create' | 'update';
      actorId?: number;
      previousSignature?: string;
    },
  ): void {
    this.notify(orderId, opts).catch((err: unknown) => {
      this.logger.error(
        `notify order #${orderId} lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async notify(
    orderId: number,
    opts: {
      action: 'create' | 'update';
      actorId?: number;
      previousSignature?: string;
    },
  ): Promise<boolean> {
    const rows = await findOrderPriceWarnings(this.prisma, [orderId]);
    if (rows.length === 0) return false;
    if (
      opts.previousSignature !== undefined &&
      opts.previousSignature === orderPriceWarningSignature(rows)
    )
      return false;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        code: true,
        createdAt: true,
        priceBookName: true,
        branch: { select: { name: true } },
        customer: { select: { code: true, name: true } },
        soldBy: { select: { name: true, larkUserId: true } },
        creator: { select: { name: true } },
      },
    });
    if (!order) return false;

    const actor = opts.actorId
      ? await this.prisma.user.findUnique({
          where: { id: opts.actorId },
          select: { name: true },
        })
      : null;

    const chatId =
      this.config.get<string>('LARK_ORDER_PRICE_CHAT_ID') || CHAT_ID;
    const card = this.buildCard(order, rows, opts.action, actor?.name);
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
        `Lark IM lỗi code=${res.code} msg=${res.msg} order=${order.code} chat=${chatId}`,
      );
      return false;
    }
    this.logger.log(`📨 Cảnh báo lệch giá ${order.code} → ${chatId}`);
    return true;
  }

  buildCard(
    order: {
      code: string;
      createdAt: Date;
      priceBookName: string | null;
      branch: { name: string } | null;
      customer: { code: string | null; name: string } | null;
      soldBy: { name: string; larkUserId: string | null } | null;
      creator: { name: string } | null;
    },
    rows: PriceRow[],
    action: 'create' | 'update',
    actorName?: string | null,
  ): Record<string, unknown> {
    const base =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050';
    const lines = [
      `**Chi nhánh:** ${order.branch?.name ?? ''}`,
      `**Đơn đặt hàng:** [${order.code}](${base}/don-hang/dat-hang?Code=${encodeURIComponent(order.code)}) (${action === 'create' ? 'tạo mới' : 'vừa sửa'})`,
      `**Bảng giá:** ${order.priceBookName ?? ''}`,
      `**Khách hàng:** ${[order.customer?.code, order.customer?.name].filter(Boolean).join(' - ')}`,
      // Tag người bán trên Lark (larkUserId là open_id); chưa liên kết Lark thì ghi tên
      `**Người bán:** ${order.soldBy?.larkUserId ? `<at id=${order.soldBy.larkUserId}></at>` : (order.soldBy?.name ?? '')}`,
      `**Người ${action === 'create' ? 'tạo' : 'sửa'}:** ${actorName ?? order.creator?.name ?? ''} · ${this.formatDateTime(action === 'create' ? order.createdAt : new Date())}`,
    ];

    const row = (cells: [string, string, string, string, string], header = false) => ({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      ...(header ? { background_style: 'grey' } : {}),
      columns: cells.map((content, i) => ({
        tag: 'column',
        width: 'weighted',
        weight: i === 0 ? 4 : 1,
        vertical_align: 'top',
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content,
              ...(i > 0 ? { text_align: 'right' } : {}),
            },
          },
        ],
      })),
    });

    const items = rows.slice(0, MAX_ROWS).map((r) => {
      const price = Number(r.price);
      const listPrice = Number(r.listPrice);
      return row([
        `${r.productCode} - ${r.productName}`,
        `${this.num(Number(r.quantity))}${r.unit ? ` ${r.unit}` : ''}`,
        `<font color='red'>${this.num(price)}</font>`,
        this.num(listPrice),
        `<font color='red'>**${this.num(price - listPrice)}**</font>`,
      ]);
    });

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: '⚠️ ĐƠN ĐẶT HÀNG BÁN THẤP HƠN GIÁ BẢNG GIÁ',
        },
        template: 'red',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'hr' },
        row(
          ['**Sản phẩm**', '**SL**', '**Giá bán**', '**Giá bảng giá**', '**Chênh lệch**'],
          true,
        ),
        ...items,
        ...(rows.length > MAX_ROWS
          ? [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `+${rows.length - MAX_ROWS} sản phẩm khác — xem trên đơn`,
                },
              },
            ]
          : []),
        {
          tag: 'note',
          elements: [
            {
              tag: 'lark_md',
              content:
                'Giá bán = đơn giá − giảm giá dòng; so với giá đang áp dụng trong bảng giá của đơn.',
            },
          ],
        },
      ],
    };
  }

  private num(n: number): string {
    return n.toLocaleString('vi-VN', { maximumFractionDigits: 3 });
  }

  private formatDateTime(date: Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    }).format(new Date(date));
  }
}
