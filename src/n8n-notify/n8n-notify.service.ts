import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

interface PackingSlipInvoiceCustomer {
  id?: number;
  name?: string | null;
  contactNumber?: string | null;
}

interface PackingSlipInvoice {
  invoiceId?: number;
  invoice?: {
    id?: number;
    code?: string;
    purchaseDate?: Date | string | null;
    grandTotal?: any;
    customer?: PackingSlipInvoiceCustomer | null;
  };
}

interface PackingSlipImage {
  imageUrl: string;
}

interface PackingSlipForNotify {
  id: number;
  code: string;
  createdAt: Date | string;
  branchId?: number | null;
  branch?: { id: number; name: string } | null;
  creator?: { id: number; name: string } | null;
  numberOfPackages: number;
  paymentMethod: string;
  cashAmount?: any;
  hasFeeGuiBen?: boolean;
  feeGuiBen?: any;
  hasFeeGrab?: boolean;
  feeGrab?: any;
  hasCuocGuiHang?: boolean;
  cuocGuiHang?: any;
  note?: string | null;
  invoices?: PackingSlipInvoice[];
  images?: PackingSlipImage[];
}

@Injectable()
export class N8nNotifyService {
  private readonly logger = new Logger(N8nNotifyService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Gửi thông báo "Báo đơn giao hàng thành công" sang n8n webhook.
   * Fire-and-log: lỗi không throw lên trên để không làm fail nghiệp vụ tạo packing slip.
   */
  async notifyDelivery(packingSlip: PackingSlipForNotify): Promise<void> {
    const webhookUrl = this.config.get<string>('N8N_DELIVERY_WEBHOOK_URL');

    if (!webhookUrl) {
      this.logger.warn(
        'N8N_DELIVERY_WEBHOOK_URL is not set — skipping delivery notification',
      );
      return;
    }

    const secret = this.config.get<string>('N8N_WEBHOOK_SECRET');
    const publicUrl =
      this.config.get<string>('APP_PUBLIC_URL') ||
      this.config.get<string>('API_URL') ||
      '';

    // Debug: log secret length and first/last chars to verify env parsing
    if (secret) {
      this.logger.debug(
        `Webhook secret: length=${secret.length}, first="${secret[0]}", last="${secret[secret.length - 1]}"`,
      );
    }

    const payload = this.buildPayload(packingSlip, publicUrl);

    try {
      await axios.post(webhookUrl, payload, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Webhook-Secret': secret } : {}),
        },
      });
      this.logger.log(
        `Notified n8n delivery for packing slip ${packingSlip.code} (id=${packingSlip.id})`,
      );
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      const body =
        typeof ax.response?.data === 'string'
          ? ax.response?.data
          : JSON.stringify(ax.response?.data ?? {});
      this.logger.error(
        `Failed to notify n8n delivery for packing slip ${packingSlip.code} (id=${packingSlip.id}): ` +
          `status=${status} message=${ax.message} body=${body}`,
      );
    }
  }

  private buildPayload(ps: PackingSlipForNotify, publicUrl: string) {
    const base = publicUrl.replace(/\/+$/, '');

    const imageUrls = (ps.images || [])
      .map((img) => this.toAbsoluteUrl(img.imageUrl, base))
      .filter((u): u is string => !!u);

    const invoices = (ps.invoices || []).map((inv) => ({
      id: inv.invoice?.id ?? inv.invoiceId,
      code: inv.invoice?.code ?? null,
      purchaseDate: inv.invoice?.purchaseDate ?? null,
      grandTotal: this.toNumber(inv.invoice?.grandTotal),
      customer: inv.invoice?.customer
        ? {
            id: inv.invoice.customer.id,
            name: inv.invoice.customer.name ?? null,
            contactNumber: inv.invoice.customer.contactNumber ?? null,
          }
        : null,
      soldByName: (inv.invoice as any)?.soldBy?.name ?? null,
    }));

    // Collect unique seller names across all invoices
    const soldByNames = invoices
      .map((inv) => inv.soldByName)
      .filter((name): name is string => !!name)
      .filter((v, i, a) => a.indexOf(v) === i);

    return {
      packingSlip: {
        id: ps.id,
        code: ps.code,
        createdAt:
          typeof ps.createdAt === 'string'
            ? ps.createdAt
            : ps.createdAt?.toISOString?.() ?? null,
        branchId: ps.branchId ?? ps.branch?.id ?? null,
        branchName: ps.branch?.name ?? null,
        creatorName: ps.creator?.name ?? null,
        soldByNames,
        numberOfPackages: ps.numberOfPackages,
        paymentMethod: ps.paymentMethod,
        cashAmount: this.toNumber(ps.cashAmount),
        hasFeeGuiBen: !!ps.hasFeeGuiBen,
        feeGuiBen: this.toNumber(ps.feeGuiBen),
        hasFeeGrab: !!ps.hasFeeGrab,
        feeGrab: this.toNumber(ps.feeGrab),
        hasCuocGuiHang: !!ps.hasCuocGuiHang,
        cuocGuiHang: this.toNumber(ps.cuocGuiHang),
        note: ps.note ?? null,
        imageUrls,
        invoices,
      },
    };
  }

  private toAbsoluteUrl(url: string, base: string): string | null {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (!base) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  private toNumber(v: any): number {
    if (v === null || v === undefined) return 0;
    const n = typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}
