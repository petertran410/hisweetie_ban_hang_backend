import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-client.provider';

/**
 * Gửi card "PHIẾU LOADING — XẾP HÀNG LÊN XE" vào Lark group khi tạo
 * phiếu loading (PackingLoading) thành công.
 *
 * Mapping branch → group (config qua env):
 *   - LARK_LOADING_CHAT_ID_HN  ← branchId = 6  (Site HN)
 *   - LARK_LOADING_CHAT_ID_SG  ← branchId = 1  (Site SG)
 *
 * Branch khác: skip silently.
 */
@Injectable()
export class LarkLoadingNotificationService {
  private readonly logger = new Logger(LarkLoadingNotificationService.name);

  // Map branchId → env var name
  private readonly BRANCH_CHAT_ENV: Record<number, string> = {
    6: 'LARK_LOADING_CHAT_ID_HN',
    1: 'LARK_LOADING_CHAT_ID_SG',
  };

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Fire-and-forget — không throw, không block caller.
   * Dùng khi gọi tự động sau khi tạo phiếu loading.
   */
  notifyLoadingCreatedAsync(loadingId: number): void {
    this.notifyLoadingCreated(loadingId).catch((err) => {
      this.logger.error(
        `notifyLoadingCreated #${loadingId} unexpected error: ${err?.message || err}`,
      );
    });
  }

  /**
   * Gửi lại thủ công — CHỜ kết quả để báo lỗi rõ ràng cho người dùng.
   * Throw nếu branch không hợp lệ hoặc chat chưa cấu hình.
   */
  async resendLoadingNotification(loadingId: number): Promise<void> {
    const loading = await this.loadLoading(loadingId);
    if (!loading) {
      throw new ServiceUnavailableException('Không tìm thấy phiếu loading');
    }

    const branchId = loading.branchId;
    const envKey =
      branchId != null ? this.BRANCH_CHAT_ENV[branchId] : undefined;
    if (!envKey) {
      throw new ServiceUnavailableException(
        `Chi nhánh #${branchId} không có group Lark để gửi loading`,
      );
    }

    const chatId = this.config.get<string>(envKey);
    if (!chatId) {
      throw new ServiceUnavailableException(`Env ${envKey} chưa được cấu hình`);
    }

    await this.sendCard(loading, chatId, envKey, { throwOnError: true });
  }

  async notifyLoadingCreated(loadingId: number): Promise<void> {
    const loading = await this.loadLoading(loadingId);
    if (!loading) {
      this.logger.warn(`Loading #${loadingId} not found, skip notification`);
      return;
    }

    const branchId = loading.branchId;
    if (branchId == null || !(branchId in this.BRANCH_CHAT_ENV)) {
      this.logger.debug(
        `Loading ${loading.code} branchId=${branchId} không thuộc HN(6)/SG(1), skip`,
      );
      return;
    }

    const envKey = this.BRANCH_CHAT_ENV[branchId];
    const chatId = this.config.get<string>(envKey);
    if (!chatId) {
      this.logger.warn(
        `Env ${envKey} chưa cấu hình, không gửi notification cho loading ${loading.code}`,
      );
      return;
    }

    await this.sendCard(loading, chatId, envKey, { throwOnError: false });
  }

  // =============================================
  // INTERNAL
  // =============================================

  private async loadLoading(loadingId: number) {
    return this.prisma.packingLoading.findUnique({
      where: { id: loadingId },
      include: {
        branch: { select: { id: true, name: true } },
        loadingBy: { select: { name: true } },
        creator: { select: { name: true } },
        invoices: {
          include: {
            invoice: {
              select: {
                id: true,
                code: true,
                customer: {
                  select: { name: true, contactNumber: true },
                },
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  private async sendCard(
    loading: any,
    chatId: string,
    envKey: string,
    opts: { throwOnError: boolean },
  ): Promise<void> {
    const card = this.buildCard(loading);

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
        const msg = `Lark IM API error code=${res.code} msg=${res.msg} loading=${loading.code} chat=${chatId}`;
        this.logger.error(msg);
        if (opts.throwOnError) {
          throw new ServiceUnavailableException(
            `Gửi Lark thất bại: ${res.msg || res.code}`,
          );
        }
        return;
      }

      this.logger.log(
        `📦 Sent loading-card for ${loading.code} → ${envKey} (${chatId})`,
      );
    } catch (error: any) {
      this.logger.error(
        `Send loading-card ${loading.code} failed: ${error?.message || error}`,
      );
      if (opts.throwOnError) {
        if (error instanceof ServiceUnavailableException) throw error;
        throw new ServiceUnavailableException(
          `Gửi Lark thất bại: ${error?.message || 'lỗi không xác định'}`,
        );
      }
    }
  }

  // =============================================
  // CARD BUILDER
  // =============================================

  private buildCard(loading: any): Record<string, any> {
    const branchName = this.formatBranchName(loading.branch?.name);
    const code = loading.code || '';
    const dateStr = this.formatDateTime(loading.createdAt);
    const loadingByName = loading.loadingBy?.name || '';
    const creatorName = loading.creator?.name || '';
    const numberOfPackages = this.formatNumber(loading.numberOfPackages);
    const note = (loading.note || '').trim();

    const headerLines: string[] = [
      `**Chi nhánh:** ${branchName}`,
      `**Mã phiếu loading:** ${code}`,
      `**Ngày tạo:** ${dateStr}`,
      `**Người loading:** ${loadingByName}`,
      `**Số kiện:** ${numberOfPackages}`,
    ];
    if (creatorName) {
      headerLines.push(`**Người tạo:** ${creatorName}`);
    }
    if (note) {
      headerLines.push(`**Ghi chú:** ${note}`);
    }

    // Bảng danh sách hóa đơn: mỗi row là 1 column_set độc lập để các cột
    // align theo hàng.
    const buildRow = (
      codeContent: string,
      customerContent: string,
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
        columns: [makeCol(2, codeContent), makeCol(3, customerContent)],
      };
    };

    const itemRows: any[] = [];
    itemRows.push(buildRow('**Mã HĐ**', '**Khách hàng**', true));

    const invoices = loading.invoices || [];
    for (const link of invoices) {
      const inv = link.invoice || {};
      const invCode = inv.code || '';
      const customer = inv.customer;
      const customerName = customer?.name || '';
      const phone = customer?.contactNumber || '';
      const customerLine = [customerName, phone].filter(Boolean).join('\n');
      itemRows.push(buildRow(invCode, customerLine));
    }

    const footerLines: string[] = [
      `**Tổng số hóa đơn:** ${invoices.length}`,
      '',
      '**🚚 ĐÃ XẾP HÀNG LÊN XE — SẴN SÀNG GIAO! 🚚**',
    ];

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: 'PHIẾU LOADING — XẾP HÀNG LÊN XE',
        },
        template: 'orange',
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

  private formatDateTime(date: Date | null | undefined): string {
    if (!date) return '';
    const d = new Date(date);
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

  private formatNumber(value: any): string {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n)
      ? String(n)
      : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
}
