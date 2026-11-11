import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-client.provider';
import {
  findInvoiceQuantityMismatches,
  InvoiceQuantityMismatch,
} from '../../invoices/invoice-quantity-mismatch';

const CHAT_ID = 'oc_2db07103de151dd3ca22fa3eef34e5f2';
const MAX_ROWS = 30;

/** Dấu vân tay của các dòng lệch — sửa hóa đơn mà lệch y như cũ thì không báo lại. */
export function quantityMismatchSignature(
  m: InvoiceQuantityMismatch | null | undefined,
): string {
  if (!m) return '';
  return JSON.stringify(
    m.items.map((i) => [i.productCode, i.invoiceQuantity, i.expectedQuantity]),
  );
}

/**
 * Gửi card cảnh báo vào nhóm Lark khi SL hóa đơn khác đơn đặt hàng
 * (đơn tách giao: so với SL còn lại, xem findInvoiceQuantityMismatches).
 *
 * Hóa đơn Kho Sài Gòn (1), Kho Hà Nội (6), Văn phòng Hà Nội (4) → một nhóm chung
 * (env LARK_INVOICE_QTY_CHAT_ID ghi đè được). Chi nhánh khác: bỏ qua.
 */
@Injectable()
export class LarkInvoiceQuantityNotificationService {
  private readonly logger = new Logger(
    LarkInvoiceQuantityNotificationService.name,
  );

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private chatIdFor(branchId: number | null): string | null {
    if (branchId !== 1 && branchId !== 6 && branchId !== 4) return null;
    return this.config.get<string>('LARK_INVOICE_QTY_CHAT_ID') || CHAT_ID;
  }

  /** Fire-and-forget — không throw, không chặn response. */
  notifyAsync(
    invoiceId: number,
    opts: {
      action: 'create' | 'update';
      actorId?: number;
      previousSignature?: string;
    },
  ): void {
    this.notify(invoiceId, opts).catch((err: unknown) => {
      this.logger.error(
        `notify invoice #${invoiceId} lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async notify(
    invoiceId: number,
    opts: {
      action: 'create' | 'update';
      actorId?: number;
      previousSignature?: string;
    },
  ): Promise<boolean> {
    const mismatch = (
      await findInvoiceQuantityMismatches(this.prisma, [invoiceId])
    ).get(invoiceId);
    if (!mismatch) return false;
    if (
      opts.previousSignature !== undefined &&
      opts.previousSignature === quantityMismatchSignature(mismatch)
    )
      return false;

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        code: true,
        branchId: true,
        createdAt: true,
        branch: { select: { name: true } },
        customer: { select: { code: true, name: true } },
        soldBy: { select: { name: true, larkUserId: true } },
        creator: { select: { name: true } },
      },
    });
    if (!invoice) return false;

    const chatId = this.chatIdFor(invoice.branchId);
    if (!chatId) return false;

    const actor = opts.actorId
      ? await this.prisma.user.findUnique({
          where: { id: opts.actorId },
          select: { name: true },
        })
      : null;

    const card = this.buildCard(invoice, mismatch, opts.action, actor?.name);
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
        `Lark IM lỗi code=${res.code} msg=${res.msg} invoice=${invoice.code} chat=${chatId}`,
      );
      return false;
    }
    this.logger.log(`📨 Cảnh báo lệch SL ${invoice.code} → ${chatId}`);
    return true;
  }

  buildCard(
    invoice: {
      code: string;
      createdAt: Date;
      branch: { name: string } | null;
      customer: { code: string | null; name: string } | null;
      soldBy: { name: string; larkUserId: string | null } | null;
      creator: { name: string } | null;
    },
    m: InvoiceQuantityMismatch,
    action: 'create' | 'update',
    actorName?: string | null,
  ): Record<string, unknown> {
    const base =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050';
    const link = (path: string, code: string) =>
      `[${code}](${base}${path}?Code=${encodeURIComponent(code)})`;
    const split = m.previousInvoiceCodes.length > 0;

    const lines = [
      `**Chi nhánh:** ${invoice.branch?.name ?? ''}`,
      `**Hóa đơn:** ${link('/don-hang/hoa-don', invoice.code)} (${action === 'create' ? 'tạo mới' : 'vừa sửa'})`,
      `**Đơn đặt hàng:** ${link('/don-hang/dat-hang', m.orderCode)}`,
      ...(split
        ? [
            `**Đơn tách giao:** so với SL đặt còn lại sau ${m.previousInvoiceCodes.join(', ')}`,
          ]
        : []),
      `**Khách hàng:** ${[invoice.customer?.code, invoice.customer?.name].filter(Boolean).join(' - ')}`,
      // Tag người bán trên Lark (larkUserId là open_id); chưa liên kết Lark thì ghi tên
      `**Người bán:** ${invoice.soldBy?.larkUserId ? `<at id=${invoice.soldBy.larkUserId}></at>` : (invoice.soldBy?.name ?? '')}`,
      `**Người ${action === 'create' ? 'tạo' : 'sửa'}:** ${actorName ?? invoice.creator?.name ?? ''} · ${this.formatDateTime(action === 'create' ? invoice.createdAt : new Date())}`,
    ];

    const row = (cells: [string, string, string, string], header = false) => ({
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

    const rows = m.items.slice(0, MAX_ROWS).map((i) => {
      const diff = i.invoiceQuantity - i.expectedQuantity;
      const color = diff < 0 ? 'red' : 'orange';
      const unit = i.unit ? ` ${i.unit}` : '';
      return row([
        `${i.productCode} - ${i.productName}`,
        `${this.num(i.invoiceQuantity)}${unit}`,
        `${this.num(i.expectedQuantity)}${unit}`,
        `<font color='${color}'>**${diff > 0 ? '+' : ''}${this.num(diff)}**</font>`,
      ]);
    });

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `⚠️ HÓA ĐƠN LỆCH SỐ LƯỢNG SO VỚI ĐƠN ĐẶT HÀNG`,
        },
        template: 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'hr' },
        row(
          [
            '**Sản phẩm**',
            '**SL HĐ**',
            split ? '**SL đặt còn lại**' : '**SL đặt**',
            '**Chênh lệch**',
          ],
          true,
        ),
        ...rows,
        ...(m.items.length > MAX_ROWS
          ? [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `+${m.items.length - MAX_ROWS} sản phẩm khác — xem trên hóa đơn`,
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
                "Chênh lệch = SL HĐ − SL đặt: <font color='red'>đỏ</font> là hóa đơn thiếu, <font color='orange'>cam</font> là hóa đơn dư.",
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
