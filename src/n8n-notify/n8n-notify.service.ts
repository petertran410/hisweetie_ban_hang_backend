import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

interface PackingSlipInvoiceCustomer {
  id?: number;
  code?: string | null;
  name?: string | null;
  contactNumber?: string | null;
}

interface PackingSlipInvoice {
  invoiceId?: number;
  consignmentId?: number;
  invoice?: {
    id?: number;
    code?: string;
    purchaseDate?: Date | string | null;
    grandTotal?: any;
    customer?: PackingSlipInvoiceCustomer | null;
    soldBy?: { name?: string | null } | null;
  };
  consignment?: {
    id?: number;
    code?: string;
    consignDate?: Date | string | null;
    grandTotal?: any;
    customer?: PackingSlipInvoiceCustomer | null;
    soldBy?: { name?: string | null } | null;
  };
}

interface PackingSlipImage {
  imageUrl: string;
}

export interface NotifyDeliveryResult {
  /** Webhook trả về 2xx */
  ok: boolean;
  /** Bị bỏ qua do chưa cấu hình N8N_DELIVERY_WEBHOOK_URL */
  skipped: boolean;
  /** HTTP status nếu có gọi webhook */
  status?: number;
  /** Thông điệp lỗi nếu gọi webhook thất bại */
  error?: string;
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
  hasCuocNhanHang?: boolean;
  cuocNhanHang?: any;
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
   * Fire-and-log: KHÔNG throw lên trên để không làm fail nghiệp vụ tạo/cập nhật packing slip.
   * Trả về kết quả để caller (vd: API "Gửi lại") biết thành công / bị skip / lỗi.
   */
  async notifyDelivery(
    packingSlip: PackingSlipForNotify,
  ): Promise<NotifyDeliveryResult> {
    const webhookUrl = this.config.get<string>('N8N_DELIVERY_WEBHOOK_URL');

    if (!webhookUrl) {
      this.logger.warn(
        'N8N_DELIVERY_WEBHOOK_URL is not set — skipping delivery notification',
      );
      return { ok: false, skipped: true };
    }

    const secret = this.config.get<string>('N8N_WEBHOOK_SECRET');
    const publicUrl =
      this.config.get<string>('APP_PUBLIC_URL') ||
      this.config.get<string>('API_URL') ||
      '';

    const payload = this.buildPayload(packingSlip, publicUrl);

    try {
      const res = await axios.post(webhookUrl, payload, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Webhook-Secret': secret } : {}),
        },
      });
      this.logger.log(
        `Notified n8n delivery for packing slip ${packingSlip.code} (id=${packingSlip.id})`,
      );
      return { ok: true, skipped: false, status: res.status };
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
      return { ok: false, skipped: false, status, error: ax.message };
    }
  }

  /**
   * Mã khách hàng Bibi cấu hình qua N8N_BIBI_CUSTOMER_CODE (mặc định KH242699).
   */
  private getBibiCustomerCode(): string {
    return (
      this.config.get<string>('N8N_BIBI_CUSTOMER_CODE') || 'KH242699'
    ).trim();
  }

  /**
   * Phiếu có được coi là "đơn Bibi" hay không: TRUE nếu có ít nhất một hóa đơn
   * thuộc khách hàng có mã trùng N8N_BIBI_CUSTOMER_CODE.
   * Dùng để routing loại trừ: đơn Bibi CHỈ gửi webhook Bibi, KHÔNG gửi mặc định.
   */
  isBibiPackingSlip(packingSlip: PackingSlipForNotify): boolean {
    const targetCode = this.getBibiCustomerCode();
    return (packingSlip.invoices || []).some(
      (inv) => inv.invoice?.customer?.code === targetCode,
    );
  }

  /**
   * Luồng riêng: gửi báo đơn sang n8n workflow "Gửi tin nhắn giao hàng"
   * (node "Webhook Báo Đơn Thủy Bibi") KHI phiếu có hóa đơn của khách hàng
   * có mã cấu hình qua N8N_BIBI_CUSTOMER_CODE (mặc định KH242699).
   *
   * Fire-and-log: KHÔNG throw để không ảnh hưởng nghiệp vụ tạo/cập nhật
   * packing slip. Bỏ qua im lặng nếu phiếu không chứa khách hàng mục tiêu.
   */
  async notifyBibiDelivery(
    packingSlip: PackingSlipForNotify,
  ): Promise<NotifyDeliveryResult> {
    const webhookUrl = this.config.get<string>('N8N_BIBI_WEBHOOK_URL');

    if (!webhookUrl) {
      this.logger.warn(
        'N8N_BIBI_WEBHOOK_URL is not set — skipping Bibi delivery notification',
      );
      return { ok: false, skipped: true };
    }

    if (!this.isBibiPackingSlip(packingSlip)) {
      // Không phải đơn của khách Bibi → không gửi.
      return { ok: false, skipped: true };
    }

    const secret = this.config.get<string>('N8N_WEBHOOK_SECRET');
    const publicUrl =
      this.config.get<string>('APP_PUBLIC_URL') ||
      this.config.get<string>('API_URL') ||
      '';

    const payload = this.buildPayload(packingSlip, publicUrl);

    try {
      const res = await axios.post(webhookUrl, payload, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Webhook-Secret': secret } : {}),
        },
      });
      this.logger.log(
        `Notified n8n Bibi delivery for packing slip ${packingSlip.code} (id=${packingSlip.id})`,
      );
      return { ok: true, skipped: false, status: res.status };
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      const body =
        typeof ax.response?.data === 'string'
          ? ax.response?.data
          : JSON.stringify(ax.response?.data ?? {});
      this.logger.error(
        `Failed to notify n8n Bibi delivery for packing slip ${packingSlip.code} (id=${packingSlip.id}): ` +
          `status=${status} message=${ax.message} body=${body}`,
      );
      return { ok: false, skipped: false, status, error: ax.message };
    }
  }

  /**
   * Gửi thông báo "Báo đơn ký gửi giao hàng thành công" sang n8n.
   * Ký gửi luôn đi vào group Zalo riêng, không áp dụng routing Bibi.
   */
  async notifyConsignmentDelivery(
    packingSlip: PackingSlipForNotify,
  ): Promise<NotifyDeliveryResult> {
    const webhookUrl = this.config.get<string>('N8N_DEPOSIT_WEBHOOK_URL');

    if (!webhookUrl) {
      this.logger.warn(
        'N8N_DEPOSIT_WEBHOOK_URL is not set — skipping consignment delivery notification',
      );
      return { ok: false, skipped: true };
    }

    const secret = this.config.get<string>('N8N_WEBHOOK_SECRET');
    const publicUrl =
      this.config.get<string>('APP_PUBLIC_URL') ||
      this.config.get<string>('API_URL') ||
      '';
    const payload = this.buildPayload(packingSlip, publicUrl);

    try {
      const res = await axios.post(webhookUrl, payload, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Webhook-Secret': secret } : {}),
        },
      });
      this.logger.log(
        `Notified n8n consignment delivery for packing slip ${packingSlip.code} (id=${packingSlip.id})`,
      );
      return { ok: true, skipped: false, status: res.status };
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      const body =
        typeof ax.response?.data === 'string'
          ? ax.response?.data
          : JSON.stringify(ax.response?.data ?? {});
      this.logger.error(
        `Failed to notify n8n consignment delivery for packing slip ${packingSlip.code} (id=${packingSlip.id}): ` +
          `status=${status} message=${ax.message} body=${body}`,
      );
      return { ok: false, skipped: false, status, error: ax.message };
    }
  }

  private buildPayload(ps: PackingSlipForNotify, publicUrl: string) {
    const base = publicUrl.replace(/\/+$/, '');

    const imageUrls = (ps.images || [])
      .map((img) => this.toAbsoluteUrl(img.imageUrl, base))
      .filter((u): u is string => !!u);

    const invoices = (ps.invoices || []).map((inv) => {
      const document = inv.invoice ?? inv.consignment;
      const customer = document?.customer;
      const soldByName = document?.soldBy?.name ?? null;

      return {
        id: document?.id ?? inv.invoiceId ?? inv.consignmentId,
        code: document?.code ?? null,
        purchaseDate:
          inv.invoice?.purchaseDate ?? inv.consignment?.consignDate ?? null,
        grandTotal: this.toNumber(document?.grandTotal),
        customer: customer
          ? {
              id: customer.id,
              code: customer.code ?? null,
              name: customer.name ?? null,
              contactNumber: customer.contactNumber ?? null,
            }
          : null,
        soldByName,
      };
    });

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
            : (ps.createdAt?.toISOString?.() ?? null),
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
        hasCuocNhanHang: !!ps.hasCuocNhanHang,
        cuocNhanHang: this.toNumber(ps.cuocNhanHang),
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
    const n =
      typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}
