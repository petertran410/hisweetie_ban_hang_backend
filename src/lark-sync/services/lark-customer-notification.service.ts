import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { LARK_CLIENT } from '../lark-client.provider';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 86_400_000;
const TZ = 'Asia/Ho_Chi_Minh';

export type LarkCustomerNotifyKind = 'taxCode' | 'newCustomerTask';

export interface LarkNotifyRecipient {
  id: number;
  name: string;
  larkUserId: string;
}

export interface LarkNotifyResult {
  sent: string[];
  failed: { name: string; error: string }[];
}

export interface LarkCustomerInfo {
  code: string | null;
  name: string;
  organization: string | null;
  branchName: string | null;
  phone: string | null;
  taxCode: string | null;
}

const EMPTY_RESULT: LarkNotifyResult = { sent: [], failed: [] };

const SAMPLE_CUSTOMER: LarkCustomerInfo = {
  code: null,
  name: '[Thử] Khách hàng mẫu',
  organization: 'Công ty TNHH Mẫu',
  branchName: 'Chi nhánh mẫu',
  phone: '0900000000',
  taxCode: '0123456789',
};

/**
 * Thông báo Lark theo khách hàng, người nhận cấu hình ở /cai-dat/thong-bao-lark:
 * - KH đổi mã số thuế → tin riêng (card) cho từng người.
 * - KH mới → 1 task Lark giao cho tất cả người được chọn.
 * Chỉ gọi từ CustomersService.create/update (thao tác tay trên POS + Public API);
 * import Excel và đồng bộ KiotViet không đi qua đây.
 */
@Injectable()
export class LarkCustomerNotificationService {
  private readonly logger = new Logger(LarkCustomerNotificationService.name);

  constructor(
    @Inject(LARK_CLIENT) private readonly client: lark.Client,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private base() {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
  }

  customerLink(code: string | null) {
    return code
      ? `${this.base()}/khach-hang?Code=${encodeURIComponent(code)}`
      : `${this.base()}/khach-hang`;
  }

  // ─── Đổi mã số thuế ────────────────────────────────────────────────

  notifyTaxCodeChangedAsync(input: {
    customerId: number;
    oldTaxCode: string | null;
    newTaxCode: string | null;
    actorUserId?: number;
  }): void {
    void this.notifyTaxCodeChanged(input)
      .then((result) =>
        this.logFailures(`đổi MST KH#${input.customerId}`, result),
      )
      .catch((error) =>
        this.logger.error(
          `Gửi tin đổi MST KH#${input.customerId} thất bại: ${error?.message || error}`,
        ),
      );
  }

  async notifyTaxCodeChanged(input: {
    customerId: number;
    oldTaxCode: string | null;
    newTaxCode: string | null;
    actorUserId?: number;
  }): Promise<LarkNotifyResult> {
    const { taxCodeUserIds } = await this.loadConfig();
    const recipients = await this.usersFor(taxCodeUserIds);
    if (!recipients.length) return EMPTY_RESULT;

    const customer = await this.loadCustomer(input.customerId);
    if (!customer) return EMPTY_RESULT;

    const card = this.buildTaxCodeCard({
      customer,
      oldTaxCode: input.oldTaxCode,
      newTaxCode: input.newTaxCode,
      actorName: await this.actorName(input.actorUserId),
      changedAt: new Date(),
    });
    return this.sendCard(recipients, card);
  }

  buildTaxCodeCard(input: {
    customer: LarkCustomerInfo;
    oldTaxCode: string | null;
    newTaxCode: string | null;
    actorName: string;
    changedAt: Date;
    test?: boolean;
  }) {
    const { customer } = input;
    const link = this.customerLink(customer.code);
    const lines = [
      `**Khách hàng:** [${this.customerLabel(customer)}](${link})`,
      `**Công ty:** ${customer.organization || '—'}`,
      `**Chi nhánh:** ${customer.branchName || '—'}`,
      `**Mã số thuế:** ${input.oldTaxCode?.trim() || '—'} → **${input.newTaxCode?.trim() || '—'}**`,
      `**Người sửa:** ${input.actorName}`,
      `**Thời gian:** ${input.changedAt.toLocaleString('vi-VN', { timeZone: TZ })}`,
    ];
    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `${input.test ? '[Thử] ' : ''}Khách hàng đổi mã số thuế`,
        },
        template: 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Mở khách hàng' },
              type: 'primary',
              url: link,
            },
          ],
        },
      ],
    };
  }

  // ─── Khách hàng mới → task ─────────────────────────────────────────

  createNewCustomerTaskAsync(customerId: number, actorUserId?: number): void {
    void this.createNewCustomerTask(customerId, actorUserId).catch((error) =>
      this.logger.error(
        `Tạo task Lark cho KH mới #${customerId} thất bại: ${error?.message || error}`,
      ),
    );
  }

  async createNewCustomerTask(
    customerId: number,
    actorUserId?: number,
  ): Promise<LarkNotifyResult> {
    const { newCustomerUserIds, dueDays } = await this.loadConfig();
    const recipients = await this.usersFor(newCustomerUserIds);
    if (!recipients.length) return EMPTY_RESULT;

    const customer = await this.loadCustomer(customerId);
    if (!customer) return EMPTY_RESULT;

    const createdAt = new Date();
    await this.createTask(recipients, {
      customer,
      actorName: await this.actorName(actorUserId),
      createdAt,
      dueDays,
      // Idempotent khi gọi lại; kèm thời điểm để dev/prod dùng chung app Lark không đụng id.
      clientToken: `pos-customer-${customerId}-${createdAt.getTime()}`,
    });
    return { sent: recipients.map((u) => u.name), failed: [] };
  }

  buildTaskDescription(input: {
    customer: LarkCustomerInfo;
    actorName: string;
    createdAt: Date;
  }) {
    const { customer } = input;
    return [
      'Khách hàng mới vừa được tạo trên POS.',
      `Mã KH: ${customer.code || '—'}`,
      `Tên: ${customer.name}`,
      `Công ty: ${customer.organization || '—'}`,
      `Số điện thoại: ${customer.phone || '—'}`,
      `Mã số thuế: ${customer.taxCode || '—'}`,
      `Chi nhánh: ${customer.branchName || '—'}`,
      `Người tạo: ${input.actorName}`,
      `Thời gian tạo: ${input.createdAt.toLocaleString('vi-VN', { timeZone: TZ })}`,
      `Xem trên POS: ${this.customerLink(customer.code)}`,
    ].join('\n');
  }

  private async createTask(
    recipients: LarkNotifyRecipient[],
    input: {
      customer: LarkCustomerInfo;
      actorName: string;
      createdAt: Date;
      dueDays: number;
      clientToken: string;
      test?: boolean;
    },
  ): Promise<void> {
    const link = this.customerLink(input.customer.code);
    const response = await this.client.task.v2.task.create({
      params: { user_id_type: 'open_id' },
      data: {
        summary: `${input.test ? '[Thử] ' : ''}Khách hàng mới: ${this.customerLabel(input.customer)}`,
        description: this.buildTaskDescription(input),
        due: {
          timestamp: String(input.createdAt.getTime() + input.dueDays * DAY_MS),
          is_all_day: false,
        },
        origin: {
          platform_i18n_name: { en_us: 'POS' },
          href: { url: link, title: 'Mở khách hàng trên POS' },
        },
        members: recipients.map((u) => ({
          id: u.larkUserId,
          type: 'user',
          role: 'assignee',
        })),
        client_token: input.clientToken,
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(
        `Lark ${response.code}: ${response.msg || 'unknown error'}`,
      );
    }
  }

  // ─── Gửi thử từ trang cài đặt ──────────────────────────────────────

  async sendTest(
    kind: LarkCustomerNotifyKind,
    actorUserId?: number,
  ): Promise<LarkNotifyResult> {
    const config = await this.loadConfig();
    const recipients = await this.usersFor(
      kind === 'taxCode' ? config.taxCodeUserIds : config.newCustomerUserIds,
    );
    if (!recipients.length) {
      throw new BadRequestException(
        'Chưa chọn người nhận hoặc người nhận chưa gắn Lark',
      );
    }
    const actorName = await this.actorName(actorUserId);
    const now = new Date();

    if (kind === 'taxCode') {
      const card = this.buildTaxCodeCard({
        customer: SAMPLE_CUSTOMER,
        oldTaxCode: '0100000000',
        newTaxCode: SAMPLE_CUSTOMER.taxCode,
        actorName,
        changedAt: now,
        test: true,
      });
      return this.sendCard(recipients, card);
    }

    try {
      await this.createTask(recipients, {
        customer: SAMPLE_CUSTOMER,
        actorName,
        createdAt: now,
        dueDays: config.dueDays,
        clientToken: `pos-test-${now.getTime()}`,
        test: true,
      });
      return { sent: recipients.map((u) => u.name), failed: [] };
    } catch (error: any) {
      const message = error?.message || String(error);
      return {
        sent: [],
        failed: recipients.map((u) => ({ name: u.name, error: message })),
      };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private customerLabel(customer: LarkCustomerInfo) {
    return customer.code
      ? `${customer.name} (${customer.code})`
      : customer.name;
  }

  private async loadConfig() {
    const settings = await this.prisma.settings.findFirst({
      select: {
        larkTaxCodeNotifyUserIds: true,
        larkNewCustomerTaskUserIds: true,
        larkNewCustomerTaskDueDays: true,
      },
    });
    return {
      taxCodeUserIds: settings?.larkTaxCodeNotifyUserIds ?? [],
      newCustomerUserIds: settings?.larkNewCustomerTaskUserIds ?? [],
      dueDays: settings?.larkNewCustomerTaskDueDays || 1,
    };
  }

  private async usersFor(ids: number[]): Promise<LarkNotifyRecipient[]> {
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, isActive: true, larkUserId: { not: null } },
      select: { id: true, name: true, larkUserId: true },
      orderBy: { name: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      larkUserId: u.larkUserId as string,
    }));
  }

  private async loadCustomer(id: number): Promise<LarkCustomerInfo | null> {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        code: true,
        name: true,
        organization: true,
        contactNumber: true,
        phone: true,
        taxCode: true,
        branch: { select: { name: true } },
      },
    });
    if (!customer) return null;
    return {
      code: customer.code,
      name: customer.name,
      organization: customer.organization,
      branchName: customer.branch?.name ?? null,
      phone: customer.contactNumber || customer.phone,
      taxCode: customer.taxCode,
    };
  }

  private async actorName(userId?: number) {
    if (!userId) return 'Hệ thống';
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return user?.name || user?.email || 'Hệ thống';
  }

  private async sendCard(
    recipients: LarkNotifyRecipient[],
    card: object,
  ): Promise<LarkNotifyResult> {
    const content = JSON.stringify(card);
    const results = await Promise.allSettled(
      recipients.map(async (user) => {
        const response = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: user.larkUserId,
            msg_type: 'interactive',
            content,
          },
        });
        if (response?.code && response.code !== 0) {
          throw new Error(
            `Lark ${response.code}: ${response.msg || 'unknown error'}`,
          );
        }
      }),
    );
    const result: LarkNotifyResult = { sent: [], failed: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') result.sent.push(recipients[i].name);
      else
        result.failed.push({
          name: recipients[i].name,
          error: r.reason?.message || String(r.reason),
        });
    });
    return result;
  }

  private logFailures(context: string, result: LarkNotifyResult) {
    for (const f of result.failed) {
      this.logger.warn(`Lark ${context} → ${f.name}: ${f.error}`);
    }
  }
}
