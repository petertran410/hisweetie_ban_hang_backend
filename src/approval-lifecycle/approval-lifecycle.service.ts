import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import {
  APPROVAL_DEFINITIONS,
  APPROVAL_BRANCHES,
  APPROVAL_FORM_VERSION,
  APPROVAL_STATUS_ORDER,
  EXPENSE_FIELD_IDS,
  EXPENSE_VP_OPTIONS,
  larkFundCutoff,
  larkLedgerCutoff,
  PAYMENT_VOUCHER,
  readFundReceipt,
  readPaymentVoucherCash,
  readSalaryAdvance,
  SALARY_ADVANCE,
  RECEIPT_FIELD_IDS,
  RECEIPT_LOCATION_BRANCHES,
  RECEIPT_OPTIONS,
  type ApprovalFormItem,
  type ApprovalInstanceStatus,
  type ApprovalRequestKind,
  type LarkFormKind,
} from './approval-lifecycle.constants';
import type { CreateApprovalRequestDto } from './dto/create-approval-request.dto';
import type { ApprovalRequestQueryDto } from './dto/approval-request-query.dto';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import { cancelWeeklyBatchInTx } from '../internal-finance/weekly-batch-cancel';
import {
  approvalHistory,
  endingStep,
} from '../internal-finance/approval-history';
import {
  LarkApprovalMirrorService,
  larkTime,
  type LarkMirrorResult,
} from './lark-approval-mirror.service';
import {
  FINANCE_AUDIT_ENTITY,
  FinanceAuditService,
  approvalAuditRef,
  approvalStatusLabel,
  auditActor,
  batchStatusLabel,
  branchLabel,
  entryStatusLabel,
  formatMoney,
  reasonSuffix,
  type AuditActor,
  type FinanceAuditChange,
  type FinanceAuditEntry,
  type FinanceAuditParams,
  type FinanceAuditSnapshot,
} from '../finance-audit';

type ApprovalEvent = {
  approval_code?: string;
  instance_code?: string;
  status?: string;
  instance_operate_time?: string;
  uuid?: string;
};

/** Đơn nhân viên tạo trực tiếp trên Lark (POS nhận về với clientUuid LARK:...). */
function isLarkCreated(clientUuid: string | null | undefined) {
  return String(clientUuid || '').startsWith('LARK:');
}

// Đơn duyệt tuần: tạo từ POS hoặc đồng bộ từ Lark khi còn đang chờ duyệt.
const WEEKLY_SOURCE_TYPES = ['INTERNAL_FINANCE_WEEKLY', 'LARK_IMPORT_WEEKLY'];

/** Các trường của đơn dùng để ghi lịch sử (thiếu trường nào thì bỏ qua). */
type ApprovalAuditRow = {
  id: number;
  kind?: string | null;
  status?: string | null;
  sourceType?: string | null;
  sourceId?: number | null;
  branchId?: number | null;
  instanceCode?: string | null;
  clientUuid?: string | null;
  createdById?: number | null;
  formSnapshot?: unknown;
  detailSnapshot?: unknown;
};

type ApprovalAuditAction =
  | 'FIN_APPROVAL_CREATE'
  | 'FIN_APPROVAL_CREATE_FAILED'
  | 'FIN_APPROVAL_STATUS'
  | 'FIN_APPROVAL_REVERT';

/** Phiếu trong batch tuần: đủ để ghi lịch sử đổi trạng thái / gỡ khỏi batch. */
const ENTRY_AUDIT_SELECT = {
  id: true,
  code: true,
  status: true,
  branchId: true,
} as const;

type EntryAuditRow = {
  id: number;
  code: string;
  status: string;
  branchId: number;
};

/** Actor kèm người được ghi thay (người tạo đơn) nếu actor chưa có. */
function onBehalfOf(actor: AuditActor, userId?: number | null): AuditActor {
  return actor.onBehalfOfUserId || !userId
    ? actor
    : { ...actor, onBehalfOfUserId: userId };
}

/**
 * Người tạo đơn để ghi thay khi CHƯA tra bản sao Lark: đơn tạo từ POS là
 * createdById; đơn nhân viên tạo trên Lark thì null (createdById có thể chỉ là
 * user 1 dự phòng khi open_id chưa gắn tài khoản POS) — applyLarkStatus tra
 * requesterId của bản sao.
 */
function posRequester(
  request?: {
    clientUuid?: string | null;
    createdById?: number | null;
  } | null,
): number | null {
  if (!request || isLarkCreated(request.clientUuid)) return null;
  return request.createdById ?? null;
}

@Injectable()
export class ApprovalLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ApprovalLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
    private readonly fundLedger: InternalFundLedgerService,
    private readonly larkMirror: LarkApprovalMirrorService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  /**
   * `actor`: người tạo đơn để ghi lịch sử (mặc định user `userId` qua HTTP);
   * truyền actor của thao tác gọi để các dòng lịch sử dùng chung opId.
   */
  async create(
    dto: CreateApprovalRequestDto,
    userId: number,
    actor?: AuditActor,
  ) {
    const kind = this.parseKind(dto.kind);
    const definition = APPROVAL_DEFINITIONS[kind];
    const clientUuid = dto.clientUuid?.trim() || randomUUID();
    if (clientUuid.length > 64) {
      throw new BadRequestException('clientUuid không được vượt quá 64 ký tự');
    }

    const existing = await this.prisma.approvalRequest.findUnique({
      where: { clientUuid },
    });
    if (existing && existing.instanceCode)
      return this.serializeRequest(existing);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, larkUserId: true },
    });
    if (!user?.larkUserId) {
      throw new BadRequestException(
        'Tài khoản POS chưa được gắn larkUserId, không thể tạo Approval',
      );
    }
    if (dto.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: dto.branchId },
        select: { id: true, name: true, isActive: true },
      });
      if (!branch || !branch.isActive) {
        throw new BadRequestException(
          `Chi nhánh ${dto.branchId} không tồn tại hoặc đang tắt`,
        );
      }
    }

    const form: ApprovalFormItem[] = dto.form.map((item) => ({
      id: item.id,
      type: item.type,
      ...(item.value !== undefined ? { value: item.value } : {}),
    }));
    if (
      kind === 'RECEIPT' &&
      !form.some((item) => item.id === RECEIPT_FIELD_IDS.payer)
    ) {
      form.push({
        id: RECEIPT_FIELD_IDS.payer,
        type: 'contact',
        value: [user.larkUserId],
      });
    }
    this.validateForm(kind, form, dto.branchId);
    const formSnapshot = JSON.parse(
      JSON.stringify({
        version: APPROVAL_FORM_VERSION,
        form,
        ...(dto.metadata !== undefined ? { metadata: dto.metadata } : {}),
      }),
    ) as Prisma.InputJsonValue;

    const by = actor ?? auditActor.user(userId);
    const amount = this.toNumber(
      form.find(
        (item) =>
          item.id ===
          (kind === 'RECEIPT'
            ? RECEIPT_FIELD_IDS.amount
            : EXPENSE_FIELD_IDS.common.amount),
      )?.value,
    );
    // Tạo (hoặc gửi lại đơn chưa lên được Lark) và ghi lịch sử cùng transaction.
    const request = await this.prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.approvalRequest.update({
            where: { id: existing.id },
            data: {
              status: 'PENDING',
              formSnapshot,
            },
          })
        : await tx.approvalRequest.create({
            data: {
              kind,
              approvalCode: definition.approvalCode,
              clientUuid,
              branchId: dto.branchId,
              sourceType: dto.sourceType,
              sourceId: dto.sourceId,
              createdById: user.id,
              formSnapshot,
            },
          });
      await this.financeAudit.write(
        tx,
        this.approvalEntry('FIN_APPROVAL_CREATE', row, by, {
          snapshot: this.approvalCreateSnapshot(row, amount),
          metadata: existing
            ? { retry: true, statusBefore: existing.status }
            : undefined,
        }),
      );
      return row;
    });

    try {
      const response = await this.larkClient.approval.v4.instance.create({
        data: {
          approval_code: definition.approvalCode,
          open_id: user.larkUserId,
          form: JSON.stringify(form),
          uuid: clientUuid,
          with_link: true,
        },
      });

      if (response?.code && response.code !== 0) {
        throw new Error(response.msg || `Lark Approval error ${response.code}`);
      }

      const instanceCode = response?.data?.instance_code;
      if (!instanceCode) {
        throw new Error('Lark không trả về instance_code');
      }

      const updated = await this.prisma.approvalRequest.update({
        where: { id: request.id },
        data: {
          instanceCode,
          detailSnapshot: response.data,
        },
      });
      // Sự kiện Lark về trước khi lưu mã đơn: xử lý như webhook, cùng opId.
      await this.replayOrphanEvents(
        updated.id,
        instanceCode,
        auditActor.system('LARK', 'lark-webhook', user.id, by.opId),
      );
      return this.serializeRequest(updated);
    } catch (error: any) {
      const message =
        (error instanceof Error && error.message) || 'Không tạo được Approval';
      await this.prisma.$transaction(async (tx) => {
        const failed = await tx.approvalRequest.update({
          where: { id: request.id },
          data: {
            status: 'CREATE_FAILED',
            detailSnapshot: {
              error: message,
            },
          },
        });
        await this.financeAudit.write(
          tx,
          this.approvalEntry(
            'FIN_APPROVAL_CREATE_FAILED',
            { ...request, ...failed, id: request.id },
            by,
            {
              params: { error: message },
              changes: this.statusChanges(request.status, 'CREATE_FAILED'),
              metadata: { error: message },
            },
          ),
        );
      });
      throw new BadRequestException(
        error?.message || 'Không tạo được Approval trên Lark',
      );
    }
  }

  async findOne(id: number) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: { events: { orderBy: { receivedAt: 'desc' }, take: 20 } },
    });
    if (!request)
      throw new NotFoundException('Không tìm thấy yêu cầu Approval');
    if (
      ['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
        request.sourceType || '',
      )
    ) {
      throw new BadRequestException(
        'Approval quỹ nội bộ phải được xem tại module Quỹ nội bộ',
      );
    }
    return this.serializeRequest(request);
  }

  async findAll(query: ApprovalRequestQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 30;
    const where: any = {
      AND: [
        {
          OR: [
            { sourceType: null },
            {
              sourceType: {
                notIn: [
                  'INTERNAL_FUND_RECEIPT',
                  'INTERNAL_FUND_TRANSFER',
                  PAYMENT_VOUCHER.sourceType,
                  SALARY_ADVANCE.sourceType,
                ],
              },
            },
          ],
        },
      ],
    };
    if (query.kind) where.kind = query.kind;
    if (query.status) where.status = query.status;
    if (query.branchId) where.branchId = query.branchId;
    if (query.search) {
      where.AND.push({
        OR: [
          { clientUuid: { contains: query.search, mode: 'insensitive' } },
          { instanceCode: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const [rows, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.serializeRequest(row)),
      total,
      page,
      limit,
    };
  }

  async findTempAdvanceOptions(search?: string) {
    const baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN');
    if (!baseToken) {
      throw new BadRequestException(
        'LARK_EXPENSE_BASE_TOKEN chưa được cấu hình',
      );
    }

    const rawItems: any[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const response = await this.larkClient.bitable.appTableRecord.search({
        path: {
          app_token: baseToken,
          table_id: 'tbl2sDSf8W99I3Gr',
        },
        params: {
          page_size: 100,
          page_token: pageToken,
          user_id_type: 'open_id',
        },
        data: {
          field_names: [
            'Tên phiếu tạm ứng',
            'Nội dung tạm ứng',
            'Còn Lại',
            'Đã Duyệt (Kế toán)',
          ],
        },
      });

      if (response?.code && response.code !== 0) {
        throw new BadRequestException(
          response.msg || 'Không đọc được danh sách tạm ứng',
        );
      }
      rawItems.push(...(response?.data?.items || []));
      if (!response?.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }

    const needle = (search || '').trim().toLowerCase();
    const items = rawItems
      .map((item: any) => {
        const fields = item.fields || {};
        const name = this.larkText(fields['Tên phiếu tạm ứng']);
        const content = this.larkText(fields['Nội dung tạm ứng']);
        const remaining = Number(
          this.larkText(fields['Còn Lại']).replace(/,/g, ''),
        );
        const approved = this.larkText(fields['Đã Duyệt (Kế toán)']);
        return {
          value: name,
          label: name || content,
          content,
          remaining,
          approved,
          recordId: item.record_id || null,
        };
      })
      .filter(
        (item) =>
          item.approved === 'Duyệt' &&
          item.value &&
          item.remaining < 0 &&
          (!needle ||
            `${item.label} ${item.content}`.toLowerCase().includes(needle)),
      )
      .slice(0, 50);

    return { data: items };
  }

  async uploadFile(file: Express.Multer.File | undefined, type: string) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Thiếu file Approval');
    }
    if (type !== 'image' && type !== 'attachment') {
      throw new BadRequestException('Loại file Approval không hợp lệ');
    }
    if (type === 'image' && file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('Ảnh Approval không được vượt quá 10MB');
    }
    if (type === 'attachment' && file.size > 50 * 1024 * 1024) {
      throw new BadRequestException(
        'File đính kèm Approval không được vượt quá 50MB',
      );
    }

    const token = await this.larkClient.tokenManager.getTenantAccessToken();
    const form = new FormData();
    const content = new Uint8Array(file.buffer.length);
    content.set(file.buffer);
    form.append('name', file.originalname);
    form.append('type', type);
    form.append(
      'content',
      new Blob([content.buffer as ArrayBuffer], {
        type: file.mimetype || 'application/octet-stream',
      }),
      file.originalname,
    );

    const response = await fetch(
      'https://www.larksuite.com/approval/openapi/v2/file/upload',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 0 || !body?.data?.code) {
      throw new BadRequestException(
        body?.msg || 'Upload file Approval thất bại',
      );
    }

    return {
      code: body.data.code as string,
      url: body.data.url as string,
      name: file.originalname,
      type,
    };
  }

  async linkCashFlow(id: number, cashFlowId: number) {
    void id;
    void cashFlowId;
    throw new BadRequestException('Approval nội bộ không liên kết CashFlow');
  }

  async postCashFlow(id: number, userId: number) {
    void id;
    void userId;
    throw new BadRequestException(
      'Approval nội bộ ghi nhận tại Quỹ nội bộ, không tạo CashFlow',
    );
  }

  async handleInstanceEvent(event: ApprovalEvent) {
    const instanceCode = String(event.instance_code || '').trim();
    const approvalCode = String(event.approval_code || '').trim();
    const status = this.parseStatus(event.status);
    if (!instanceCode || !approvalCode || !status) {
      this.logger.warn(
        'Bỏ qua approval event thiếu instance_code/approval_code/status',
      );
      return;
    }

    const operationTime = this.parseEventTime(event.instance_operate_time);
    const eventKey = [
      instanceCode,
      status,
      event.instance_operate_time || '',
      event.uuid || '',
    ].join(':');

    const request = await this.prisma.approvalRequest.findUnique({
      where: { instanceCode },
    });
    const matchedRequest =
      request ||
      (event.uuid
        ? await this.prisma.approvalRequest.findUnique({
            where: { clientUuid: event.uuid },
          })
        : null);

    if (
      matchedRequest?.approvalCode &&
      matchedRequest.approvalCode !== approvalCode
    ) {
      throw new BadRequestException('Approval code không khớp yêu cầu POS');
    }

    let storedEvent: { id: number; processedAt?: Date | null };
    try {
      storedEvent = await this.prisma.approvalRequestEvent.create({
        data: {
          eventKey,
          approvalRequestId: matchedRequest?.id,
          approvalCode: approvalCode,
          instanceCode,
          status,
          instanceOperateTime: operationTime,
          payload: event as any,
        },
        select: { id: true, processedAt: true },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const existingEvent = await this.prisma.approvalRequestEvent.findUnique(
          {
            where: { eventKey },
            select: { id: true, processedAt: true },
          },
        );
        if (!existingEvent || existingEvent.processedAt) return;
        storedEvent = existingEvent;
      } else {
        throw error;
      }
    }

    // Lịch sử: Lark webhook ghi thay người tạo đơn.
    const actor = auditActor.system(
      'LARK',
      'lark-webhook',
      posRequester(matchedRequest),
    );

    // Đơn nhân viên tạo trực tiếp trên Lark của 4 form: lưu bản sao; PHIẾU CHI
    // / PHIẾU THU tiền mặt thì nhận vào quỹ (và Tài chính nội bộ nếu là quỹ kho).
    const larkKind = matchedRequest ? null : this.larkFormKind(approvalCode);
    let skipReason: string | null = null;
    if (larkKind) {
      const ingested = await this.ingestLarkInstance(
        instanceCode,
        approvalCode,
        larkKind,
        actor,
      );
      if (ingested.requestId) {
        await this.replayOrphanEvents(ingested.requestId, instanceCode, actor);
        return;
      }
      skipReason = ingested.skipReason;
    }

    if (!matchedRequest) {
      await this.prisma.approvalRequestEvent.update({
        where: { id: storedEvent.id },
        data: skipReason
          ? {
              processedAt: new Date(),
              error: `Đơn Lark không ghi quỹ: ${skipReason}`,
            }
          : { error: 'Không tìm thấy approval request tương ứng' },
      });
      this.logger.warn(`Approval event không có request POS: ${instanceCode}`);
      return;
    }

    try {
      await this.refreshFromLark(
        matchedRequest.id,
        instanceCode,
        status,
        actor,
        operationTime,
        undefined,
        event.uuid,
      );
      await this.prisma.approvalRequestEvent.update({
        where: { id: storedEvent.id },
        data: { processedAt: new Date(), error: null },
      });
    } catch (error: any) {
      await this.prisma.approvalRequestEvent.update({
        where: { id: storedEvent.id },
        data: {
          error: error?.message || 'Không xử lý được approval event',
        },
      });
      throw error;
    }
  }

  private paymentVoucherCode() {
    return (
      this.config.get<string>('LARK_PAYMENT_VOUCHER_APPROVAL_CODE') ||
      PAYMENT_VOUCHER.approvalCode
    );
  }

  private salaryAdvanceCode() {
    return (
      this.config.get<string>('LARK_SALARY_ADVANCE_APPROVAL_CODE') ||
      SALARY_ADVANCE.approvalCode
    );
  }

  /**
   * Nhận đơn TẠM ỨNG LƯƠNG chi tiền mặt từ một quỹ nội bộ (kho, VPHN) để trừ
   * quỹ khi duyệt. Đơn chuyển khoản chỉ có bản sao, không tạo request.
   */
  private async ingestSalaryAdvance(
    instanceCode: string,
    actor: AuditActor,
    knownDetail?: any,
  ) {
    const detail: any = knownDetail || (await this.getInstance(instanceCode));
    let form: ApprovalFormItem[] = [];
    try {
      form = JSON.parse(detail?.form || '[]');
    } catch {
      form = [];
    }
    const advance = readSalaryAdvance(form);
    if (!advance?.branchId) return null;
    const requester = detail?.open_id
      ? await this.prisma.user.findFirst({
          where: { larkUserId: String(detail.open_id) },
          select: { id: true },
        })
      : null;
    const createdById = requester?.id || 1;
    const name = await this.larkMirror.larkUserName(detail?.open_id);
    const description = name ? `Tạm ứng lương - ${name}` : 'Tạm ứng lương';
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.approvalRequest.create({
          data: {
            kind: SALARY_ADVANCE.kind,
            approvalCode: this.salaryAdvanceCode(),
            instanceCode,
            clientUuid: `LARK:${instanceCode}`,
            status: 'PENDING',
            sourceType: SALARY_ADVANCE.sourceType,
            branchId: advance.branchId,
            createdById,
            formSnapshot: {
              version: 'lark',
              form,
              metadata: {
                branchId: advance.branchId,
                amount: advance.amount,
                cashSource: advance.cashSource,
                method: advance.method,
                description,
                serialNumber: detail?.serial_number || null,
              },
            } as unknown as Prisma.InputJsonValue,
            detailSnapshot: detail as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const row: ApprovalAuditRow = {
          id: created.id,
          kind: SALARY_ADVANCE.kind,
          sourceType: SALARY_ADVANCE.sourceType,
          branchId: advance.branchId,
          instanceCode,
          clientUuid: `LARK:${instanceCode}`,
          detailSnapshot: detail,
        };
        await this.financeAudit.write(
          tx,
          this.approvalEntry(
            'FIN_APPROVAL_CREATE',
            row,
            onBehalfOf(actor, requester?.id),
            {
              snapshot: this.approvalCreateSnapshot(
                row,
                advance.amount,
                description,
              ),
            },
          ),
        );
        return created.id;
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const existing = await this.prisma.approvalRequest.findUnique({
        where: { instanceCode },
        select: { id: true },
      });
      return existing?.id || null;
    }
  }

  /**
   * Nhận đơn PHIẾU CHI tạo trực tiếp trên Lark. Chỉ lưu đơn chi tiền mặt từ
   * một trong các quỹ nội bộ; đơn khác trả null để sự kiện bị bỏ qua như cũ.
   */
  private async ingestPaymentVoucher(
    instanceCode: string,
    actor: AuditActor,
    knownDetail?: any,
  ) {
    const detail: any = knownDetail || (await this.getInstance(instanceCode));
    let form: ApprovalFormItem[] = [];
    try {
      form = JSON.parse(detail?.form || '[]');
    } catch {
      form = [];
    }
    const cash = readPaymentVoucherCash(form);
    if (!cash) return null;
    const requester = detail?.open_id
      ? await this.prisma.user.findFirst({
          where: { larkUserId: String(detail.open_id) },
          select: { id: true },
        })
      : null;
    // Người đề xuất PHIẾU CHI luôn có tài khoản POS; 1 chỉ là chốt an toàn.
    const createdById = requester?.id || 1;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.approvalRequest.create({
          data: {
            kind: PAYMENT_VOUCHER.kind,
            approvalCode: this.paymentVoucherCode(),
            instanceCode,
            clientUuid: `LARK:${instanceCode}`,
            status: 'PENDING',
            sourceType: PAYMENT_VOUCHER.sourceType,
            branchId: cash.branchId,
            createdById,
            formSnapshot: {
              version: 'lark',
              form,
              metadata: {
                ...cash,
                serialNumber: detail?.serial_number || null,
              },
            } as unknown as Prisma.InputJsonValue,
            detailSnapshot: detail as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const row: ApprovalAuditRow = {
          id: created.id,
          kind: PAYMENT_VOUCHER.kind,
          sourceType: PAYMENT_VOUCHER.sourceType,
          branchId: cash.branchId,
          instanceCode,
          clientUuid: `LARK:${instanceCode}`,
          detailSnapshot: detail,
        };
        await this.financeAudit.write(
          tx,
          this.approvalEntry(
            'FIN_APPROVAL_CREATE',
            row,
            onBehalfOf(actor, requester?.id),
            {
              snapshot: this.approvalCreateSnapshot(
                row,
                cash.amount,
                cash.description,
              ),
            },
          ),
        );
        return created.id;
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const existing = await this.prisma.approvalRequest.findUnique({
        where: { instanceCode },
        select: { id: true },
      });
      return existing?.id || null;
    }
  }

  /**
   * Nhận đơn PHIẾU THU tạo trực tiếp trên Lark. Đơn chuyển tiền giữa hai quỹ
   * thành một lệnh chuyển quỹ (duyệt xong ghi "chuyển đi" ở quỹ nguồn và
   * "chuyển đến" ở quỹ đích); đơn thu tiền mặt vào một quỹ thành phiếu thu quỹ.
   * Đơn không liên quan quỹ tiền mặt trả null để sự kiện bị bỏ qua như cũ.
   */
  private async ingestFundReceipt(
    instanceCode: string,
    actor: AuditActor,
    knownDetail?: any,
  ) {
    const detail: any = knownDetail || (await this.getInstance(instanceCode));
    let form: ApprovalFormItem[] = [];
    try {
      form = JSON.parse(detail?.form || '[]');
    } catch {
      form = [];
    }
    const receipt = readFundReceipt(form);
    if (!receipt) return null;
    const requester = detail?.open_id
      ? await this.prisma.user.findFirst({
          where: { larkUserId: String(detail.open_id) },
          select: { id: true },
        })
      : null;
    // Người đề xuất luôn có tài khoản POS; 1 chỉ là chốt an toàn.
    const createdById = requester?.id || 1;
    const clientUuid = `LARK:${instanceCode}`;
    const base = {
      kind: APPROVAL_DEFINITIONS.RECEIPT.kind,
      approvalCode: APPROVAL_DEFINITIONS.RECEIPT.approvalCode,
      instanceCode,
      clientUuid,
      status: 'PENDING',
      createdById,
      formSnapshot: {
        version: 'lark',
        form,
        metadata: { serialNumber: detail?.serial_number || null },
      } as unknown as Prisma.InputJsonValue,
      detailSnapshot: detail as Prisma.InputJsonValue,
    };
    // Lịch sử: Lark ghi thay người đề xuất.
    const by = onBehalfOf(actor, requester?.id);
    const auditRow = (
      id: number,
      sourceType: string,
      branchId: number,
      sourceId: number | null,
    ): ApprovalAuditRow => ({
      id,
      kind: base.kind,
      sourceType,
      sourceId,
      branchId,
      instanceCode,
      clientUuid,
      detailSnapshot: detail,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Thu vào / chi ra một quỹ (kể cả với Công Ty / Cá Nhân / Cửa Hàng):
        // chiều cộng / trừ đọc lại từ form lúc ghi quỹ.
        if (receipt.kind !== 'TRANSFER') {
          const created = await tx.approvalRequest.create({
            data: {
              ...base,
              sourceType: 'INTERNAL_FUND_RECEIPT',
              branchId: receipt.branchId,
            },
            select: { id: true },
          });
          const row = auditRow(
            created.id,
            'INTERNAL_FUND_RECEIPT',
            receipt.branchId,
            null,
          );
          await this.financeAudit.write(
            tx,
            this.approvalEntry('FIN_APPROVAL_CREATE', row, by, {
              snapshot: this.approvalCreateSnapshot(
                row,
                receipt.amount,
                receipt.description,
              ),
            }),
          );
          return created.id;
        }
        const transferCode = this.fundLedger.code('CHUYEN');
        const transfer = await tx.internalFundTransfer.create({
          data: {
            clientUuid,
            code: transferCode,
            sourceBranchId: receipt.sourceBranchId,
            destinationBranchId: receipt.destinationBranchId,
            amount: receipt.amount,
            occurredAt: receipt.occurredAt,
            description: receipt.description,
            status: 'PENDING',
            createdBy: createdById,
          },
          select: { id: true },
        });
        const created = await tx.approvalRequest.create({
          data: {
            ...base,
            sourceType: 'INTERNAL_FUND_TRANSFER',
            sourceId: transfer.id,
            branchId: receipt.sourceBranchId,
          },
          select: { id: true },
        });
        await tx.internalFundTransfer.update({
          where: { id: transfer.id },
          data: { approvalRequestId: created.id },
        });
        const row = auditRow(
          created.id,
          'INTERNAL_FUND_TRANSFER',
          receipt.sourceBranchId,
          transfer.id,
        );
        await this.financeAudit.write(tx, [
          this.approvalEntry('FIN_APPROVAL_CREATE', row, by, {
            snapshot: this.approvalCreateSnapshot(
              row,
              receipt.amount,
              receipt.description,
            ),
            metadata: { transferId: transfer.id, transferCode },
          }),
          {
            action: 'FIN_FUND_TRANSFER_REQUEST',
            entityType: FINANCE_AUDIT_ENTITY.FUND_TRANSFER,
            entityId: transfer.id,
            entityCode: transferCode,
            branchId: receipt.sourceBranchId,
            actor: by,
            params: {
              code: transferCode,
              amount: receipt.amount,
              fromBranch: branchLabel(receipt.sourceBranchId),
              toBranch: branchLabel(receipt.destinationBranchId),
            },
            snapshot: {
              lines: [
                {
                  label: 'Quỹ chuyển',
                  value: branchLabel(receipt.sourceBranchId),
                },
                {
                  label: 'Quỹ nhận',
                  value: branchLabel(receipt.destinationBranchId),
                },
                { label: 'Số tiền', value: formatMoney(receipt.amount) },
                { label: 'Nội dung', value: receipt.description || '—' },
              ],
            },
            metadata: {
              approvalRequestId: created.id,
              instanceCode,
              source: 'LARK_RECEIPT',
            },
          },
        ]);
        return created.id;
      });
    } catch (error: any) {
      // Hai sự kiện về cùng lúc: đơn đã được tạo ở lần kia.
      if (error?.code !== 'P2002') throw error;
      const existing = await this.prisma.approvalRequest.findUnique({
        where: { instanceCode },
        select: { id: true },
      });
      return existing?.id || null;
    }
  }

  /** Form Lark do nhân viên tạo trực tiếp mà POS nhận về; null nếu không thuộc 4 form. */
  larkFormKind(approvalCode: string): LarkFormKind | null {
    if (approvalCode === this.paymentVoucherCode()) return 'PHIEU_CHI';
    if (approvalCode === this.salaryAdvanceCode()) return 'TAM_UNG_LUONG';
    if (approvalCode === APPROVAL_DEFINITIONS.RECEIPT.approvalCode)
      return 'PHIEU_THU';
    if (approvalCode === APPROVAL_DEFINITIONS.EXPENSE_HN.approvalCode)
      return 'PHIEU_CHI_KHO_HN';
    if (approvalCode === APPROVAL_DEFINITIONS.EXPENSE_SG.approvalCode)
      return 'PHIEU_CHI_KHO_SG';
    return null;
  }

  /** Mã approval của 4 form Lark POS nhận về. */
  larkApprovalCodes() {
    return [
      this.paymentVoucherCode(),
      this.salaryAdvanceCode(),
      APPROVAL_DEFINITIONS.RECEIPT.approvalCode,
      APPROVAL_DEFINITIONS.EXPENSE_HN.approvalCode,
      APPROVAL_DEFINITIONS.EXPENSE_SG.approvalCode,
    ];
  }

  /**
   * Lưu bản sao đơn Lark rồi tạo ApprovalRequest nếu đơn ghi quỹ (PHIẾU CHI /
   * PHIẾU THU tiền mặt, theo luật quỹ cũ). PHIẾU CHI KHO tạo trên Lark chỉ lưu
   * bản sao. `fundBranches`: chỉ nhận đơn chạm vào các quỹ này (lấy bù).
   */
  private async ingestLarkInstance(
    instanceCode: string,
    approvalCode: string,
    kind: LarkFormKind,
    actor: AuditActor,
    knownDetail?: any,
    inspected?: LarkMirrorResult,
    fundBranches?: number[],
  ): Promise<{ requestId: number | null; skipReason: string | null }> {
    const detail: any = knownDetail || (await this.getInstance(instanceCode));
    const result = inspected || (await this.larkMirror.inspect(kind, detail));
    await this.larkMirror.save({
      instanceCode,
      approvalCode,
      kind,
      detail,
      inspected: result,
    });
    const allowed =
      !fundBranches ||
      result.summary.fundBranchIds.every((id) => fundBranches.includes(id));
    const requestId = !allowed
      ? null
      : kind === 'PHIEU_CHI'
        ? await this.ingestPaymentVoucher(instanceCode, actor, detail)
        : kind === 'PHIEU_THU'
          ? await this.ingestFundReceipt(instanceCode, actor, detail)
          : kind === 'TAM_UNG_LUONG' && result.summary.inScope
            ? await this.ingestSalaryAdvance(instanceCode, actor, detail)
            : null;
    if (requestId) await this.larkMirror.linkRequest(instanceCode, requestId);
    return { requestId, skipReason: result.summary.skipReason };
  }

  /** Đơn PHIẾU CHI / PHIẾU THU (thu vào một quỹ) đã có dòng trong sổ quỹ Lark. */
  /** Bên nào của đơn chuyển tiền duyệt trước mốc lên POS của quỹ đó. */
  private async transferLegsBeforeCutoff(
    tx: Prisma.TransactionClient,
    transferId: number | null,
    completedAt: Date,
  ): Promise<number[] | null> {
    if (!transferId) return null;
    const transfer = await tx.internalFundTransfer.findUnique({
      where: { id: transferId },
      select: { sourceBranchId: true, destinationBranchId: true },
    });
    if (!transfer) return null;
    return [transfer.sourceBranchId, transfer.destinationBranchId].filter(
      (branchId) => completedAt < larkLedgerCutoff(branchId),
    );
  }

  private async ledgerHasLarkOrder(
    tx: Prisma.TransactionClient,
    requestId: number,
    completedAt: Date,
  ) {
    const request = await tx.approvalRequest.findUnique({
      where: { id: requestId },
      select: { sourceType: true, branchId: true, formSnapshot: true },
    });
    if (!request?.branchId) return false;
    const snapshot = request.formSnapshot as {
      form?: ApprovalFormItem[];
      metadata?: { amount?: number };
    } | null;
    if (request.sourceType === PAYMENT_VOUCHER.sourceType) {
      const amount = Number(snapshot?.metadata?.amount || 0);
      return (
        amount > 0 &&
        this.larkMirror.hasLedgerTwin(tx, {
          branchId: request.branchId,
          receipt: false,
          amount,
          at: completedAt,
        })
      );
    }
    if (request.sourceType === 'INTERNAL_FUND_RECEIPT') {
      const receipt = readFundReceipt(snapshot?.form || []);
      return (
        (receipt?.kind === 'RECEIPT' || receipt?.kind === 'PAYOUT') &&
        this.larkMirror.hasLedgerTwin(tx, {
          branchId: receipt.branchId,
          receipt: receipt.kind === 'RECEIPT',
          amount: receipt.amount,
          at: receipt.occurredAt,
        })
      );
    }
    return false;
  }

  private async isPosUuid(uuid: unknown) {
    if (!uuid) return false;
    const request = await this.prisma.approvalRequest.findUnique({
      where: { clientUuid: String(uuid) },
      select: { clientUuid: true },
    });
    return Boolean(request && !isLarkCreated(request.clientUuid));
  }

  /** Sau khi đơn Lark đổi trạng thái: cập nhật bản sao, tạo hoặc hủy phiếu POS. */
  private async syncLarkEntry(requestId: number, actor: AuditActor) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        approvalCode: true,
        instanceCode: true,
        clientUuid: true,
        detailSnapshot: true,
      },
    });
    if (!request?.instanceCode || !isLarkCreated(request.clientUuid)) return;
    const kind = this.larkFormKind(request.approvalCode);
    if (!kind) return;
    try {
      if (request.detailSnapshot)
        await this.larkMirror.save({
          instanceCode: request.instanceCode,
          approvalCode: request.approvalCode,
          kind,
          detail: request.detailSnapshot,
          approvalRequestId: request.id,
        });
      await this.larkMirror.ensureEntry(request.id, actor);
    } catch (error: any) {
      this.logger.warn(
        `Không tạo được phiếu POS cho đơn Lark #${request.id}: ${error?.message}`,
      );
    }
  }

  /**
   * Xem trước một đơn Lark mà không ghi gì: dùng cho script lấy bù chạy thử.
   */
  async previewLarkInstance(
    instanceCode: string,
    approvalCode: string,
    fundBranches?: number[],
  ) {
    const kind = this.larkFormKind(approvalCode);
    if (!kind) return null;
    const existing = await this.prisma.approvalRequest.findUnique({
      where: { instanceCode },
      select: { id: true, clientUuid: true, sourceType: true, status: true },
    });
    if (existing && !isLarkCreated(existing.clientUuid))
      return { kind, outcome: 'POS' as const };
    const detail: any = await this.getInstance(instanceCode);
    if (!existing && (await this.isPosUuid(detail?.uuid)))
      return { kind, outcome: 'POS' as const };
    const status = this.parseStatus(detail?.status);
    const inspected = await this.larkMirror.inspect(kind, detail);
    const entry = await this.prisma.internalFinanceEntry.findUnique({
      where: { sourceKey: `LARK_APPROVAL:${instanceCode}` },
      select: { id: true },
    });
    const form = (() => {
      try {
        return JSON.parse(detail?.form || '[]');
      } catch {
        return [];
      }
    })();
    const fundEligible =
      (kind === 'PHIEU_CHI'
        ? Boolean(readPaymentVoucherCash(form))
        : kind === 'PHIEU_THU'
          ? Boolean(readFundReceipt(form))
          : kind === 'TAM_UNG_LUONG'
            ? inspected.summary.inScope
            : false) &&
      (!fundBranches ||
        inspected.summary.fundBranchIds.every((id) =>
          fundBranches.includes(id),
        ));
    const completedAt = larkTime(detail?.end_time);
    const { summary } = inspected;
    const amount = summary.cashAmount ?? summary.amount ?? 0;
    const ledgerTwin =
      fundEligible &&
      status === 'APPROVED' &&
      Boolean(summary.branchId) &&
      amount > 0 &&
      (await this.larkMirror.hasLedgerTwin(this.prisma, {
        branchId: summary.branchId!,
        receipt: summary.direction === 'RECEIPT',
        amount,
        at:
          summary.direction === 'RECEIPT'
            ? summary.occurredAt || completedAt || new Date()
            : completedAt || new Date(),
      }));
    const fund =
      status !== 'APPROVED' || !fundEligible
        ? 'none'
        : (completedAt &&
              completedAt <
                larkFundCutoff(
                  summary.branchId,
                  kind === 'TAM_UNG_LUONG' ? SALARY_ADVANCE.sourceType : null,
                )) ||
            ledgerTwin
          ? 'ledger'
          : existing?.status === status
            ? 'existing'
            : 'post';
    return {
      kind,
      outcome: 'LARK' as const,
      status,
      existingRequest: Boolean(existing),
      existingEntry: Boolean(entry),
      fund,
      completedAt,
      requesterOpenId: detail?.open_id ? String(detail.open_id) : null,
      /** Chi tiết đơn đã tải, để ghi thật không phải gọi Lark lần nữa. */
      detail,
      ...inspected,
    };
  }

  /**
   * Lấy một đơn Lark về POS như webhook: bản sao, quỹ, phiếu. `skipSuspect`
   * bỏ qua đơn có thể trùng với phiếu POS (chỉ lưu bản sao).
   */
  async syncLarkInstance(
    instanceCode: string,
    approvalCode: string,
    options: {
      skipSuspect?: boolean;
      knownDetail?: any;
      /** Lấy bù: chỉ ghi quỹ của các chi nhánh này (đơn khác chỉ lưu bản sao). */
      fundBranches?: number[];
      /**
       * Người/hệ thống thực hiện để ghi lịch sử (cron, script...). Mặc định hệ
       * thống tự động.
       */
      actor?: AuditActor;
    } = {},
  ) {
    const kind = this.larkFormKind(approvalCode);
    if (!kind) return 'UNKNOWN_FORM';
    const actor =
      options.actor ?? auditActor.system('SYSTEM', 'sync-lark-instance');
    const existing = await this.prisma.approvalRequest.findUnique({
      where: { instanceCode },
      select: { id: true, clientUuid: true, status: true },
    });
    if (existing && !isLarkCreated(existing.clientUuid)) return 'POS';
    const detail: any =
      options.knownDetail || (await this.getInstance(instanceCode));
    // Đơn POS vừa gửi nhưng chưa kịp lưu mã đơn: nhận ra qua uuid.
    if (!existing && (await this.isPosUuid(detail?.uuid))) return 'POS';
    const status = this.parseStatus(detail?.status);
    const inspected = await this.larkMirror.inspect(kind, detail);
    if (!existing && options.skipSuspect && inspected.suspectDuplicateOfId) {
      await this.larkMirror.save({
        instanceCode,
        approvalCode,
        kind,
        detail,
        inspected,
      });
      return 'SUSPECT';
    }
    const requestId = existing
      ? existing.id
      : (
          await this.ingestLarkInstance(
            instanceCode,
            approvalCode,
            kind,
            actor,
            detail,
            inspected,
            options.fundBranches,
          )
        ).requestId;
    if (!requestId) return 'MIRRORED';
    // Đơn POS đã xử lý và Lark không đổi trạng thái: không chạy lại bước quỹ
    // (dòng quỹ có thể đã bị hủy tay, chạy lại sẽ ghi quỹ lần nữa).
    if (existing && existing.status === status) {
      await this.larkMirror.save({
        instanceCode,
        approvalCode,
        kind,
        detail,
        inspected,
        approvalRequestId: existing.id,
      });
      await this.larkMirror.ensureEntry(existing.id, actor);
      return 'UNCHANGED';
    }
    if (status)
      await this.refreshFromLark(
        requestId,
        instanceCode,
        status,
        actor,
        status === 'PENDING' ? undefined : larkTime(detail?.end_time),
        detail,
      );
    else await this.syncLarkEntry(requestId, actor);
    return 'SYNCED';
  }

  /** Chốt chặn đơn lỡ webhook: mỗi giờ quét đơn 4 form tạo trong 3 ngày gần nhất. */
  @Cron('17 * * * *')
  async syncRecentLarkInstances() {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86400000);
    for (const approvalCode of this.larkApprovalCodes()) {
      try {
        const codes = await this.larkMirror.listInstanceCodes(
          approvalCode,
          from,
          to,
        );
        const done = await this.larkMirror.settledCodes(codes);
        for (const instanceCode of codes) {
          if (done.has(instanceCode)) continue;
          // Mỗi đơn là một thao tác riêng (opId riêng).
          await this.syncLarkInstance(instanceCode, approvalCode, {
            actor: auditActor.system('CRON', 'cron:syncRecentLarkInstances'),
          }).catch((error: any) =>
            this.logger.warn(
              `Không đồng bộ được đơn Lark ${instanceCode}: ${error?.message}`,
            ),
          );
        }
      } catch (error: any) {
        this.logger.warn(
          `Không quét được đơn Lark ${approvalCode}: ${error?.message}`,
        );
      }
    }
  }

  private async replayOrphanEvents(
    requestId: number,
    instanceCode: string,
    actor: AuditActor,
  ) {
    const orphanEvents = await this.prisma.approvalRequestEvent.findMany({
      where: {
        instanceCode,
        approvalRequestId: null,
      },
      orderBy: { receivedAt: 'asc' },
    });
    if (orphanEvents.length === 0) return;

    for (const event of orphanEvents) {
      await this.prisma.approvalRequestEvent.update({
        where: { id: event.id },
        data: {
          approvalRequestId: requestId,
          processedAt: null,
          error: null,
        },
      });
    }

    const latest = orphanEvents[orphanEvents.length - 1];
    const status = this.parseStatus(latest.status);
    if (status) {
      await this.refreshFromLark(
        requestId,
        instanceCode,
        status,
        actor,
        latest.instanceOperateTime,
        undefined,
        latest.eventKey,
      );
      await this.prisma.approvalRequestEvent.updateMany({
        where: { id: { in: orphanEvents.map((event) => event.id) } },
        data: { processedAt: new Date(), error: null },
      });
    }
  }

  /**
   * Người được ghi thay trong lịch sử của một đơn: đơn tạo từ POS là
   * createdById; đơn nhân viên tạo trên Lark lấy requesterId của bản sao Lark
   * (không gắn được tài khoản POS thì null, không dùng user 1 dự phòng).
   */
  private async requesterOf(
    db: Pick<Prisma.TransactionClient, 'larkApprovalInstance'>,
    request: {
      clientUuid?: string | null;
      instanceCode?: string | null;
      createdById?: number | null;
    },
  ): Promise<number | null> {
    if (!isLarkCreated(request.clientUuid)) return request.createdById ?? null;
    if (!request.instanceCode) return null;
    const mirror = await db.larkApprovalInstance.findUnique({
      where: { instanceCode: request.instanceCode },
      select: { requesterId: true },
    });
    return mirror?.requesterId ?? null;
  }

  @Cron('*/10 * * * *')
  async reconcilePending() {
    const requests = await this.prisma.approvalRequest.findMany({
      where: {
        status: 'PENDING',
        instanceCode: { not: null },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });

    for (const request of requests) {
      if (!request.instanceCode) continue;
      try {
        const detail = await this.getInstance(request.instanceCode);
        const status = this.parseStatus(detail?.status);
        if (!status) continue;
        await this.refreshFromLark(
          request.id,
          request.instanceCode,
          status,
          auditActor.system(
            'CRON',
            'cron:reconcilePending',
            posRequester(request),
          ),
          this.parseEventTime(detail?.end_time || detail?.start_time),
          detail,
        );
      } catch (error: any) {
        this.logger.warn(
          `Approval reconciliation failed #${request.id}: ${error?.message}`,
        );
      }
    }
  }

  /** Vá một lần khi khởi động; chạy nền để không làm chậm việc khởi động. */
  onApplicationBootstrap() {
    void this.repairImportedWeeks().catch((error: any) =>
      this.logger.warn(`Không vá được tuần đồng bộ: ${error?.message}`),
    );
  }

  /**
   * Tuần đồng bộ từ Lark lúc còn chờ duyệt, POS đã tự nhận kết quả duyệt (có
   * detailSnapshot) nhưng batch chưa được xử lý — vá lại một lần. Gồm cả tuần
   * kho đã bị bước đồng bộ cũ đặt thẳng "Đã duyệt" mà chưa phiếu nào Đã chi.
   * Tuần lịch sử duyệt trước khi lên POS không có detailSnapshot nên không bị đụng.
   */
  private async repairImportedWeeks() {
    const tracked = await this.prisma.approvalRequest.findMany({
      where: {
        sourceType: 'LARK_IMPORT_WEEKLY',
        status: { in: ['APPROVED', 'REJECTED', 'CANCELED', 'DELETED'] },
        detailSnapshot: { not: Prisma.DbNull },
        sourceId: { not: null },
      },
      select: {
        id: true,
        status: true,
        sourceId: true,
        createdAt: true,
        detailSnapshot: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    // Chỉ tuần Lark duyệt xong sau khi đã nhập vào POS; tuần lịch sử được lịch
    // dò hỏi lại vẫn có detailSnapshot nhưng thời điểm duyệt nằm trước đó.
    const requests = tracked.filter((request) => {
      const end = Number(
        (request.detailSnapshot as { end_time?: unknown } | null)?.end_time,
      );
      return end > request.createdAt.getTime();
    });
    if (!requests.length) return;
    const approvedIds = requests
      .filter((request) => request.status === 'APPROVED')
      .map((request) => request.sourceId!);
    const stuck = await this.prisma.internalFinanceWeeklyBatch.findMany({
      where: {
        OR: [
          {
            id: { in: requests.map((request) => request.sourceId!) },
            status: 'IN_APPROVAL',
          },
          {
            id: { in: approvedIds },
            status: 'APPROVED',
            branchId: { in: [1, 6] },
            entries: { none: { cashIssued: true } },
          },
        ],
      },
      select: { id: true },
    });
    for (const batch of stuck) {
      const request = requests.find((item) => item.sourceId === batch.id)!;
      try {
        await this.prisma.$transaction((tx) =>
          this.applyWeeklyBatchStatus(
            tx,
            {
              id: request.id,
              sourceId: batch.id,
              sourceType: 'LARK_IMPORT_WEEKLY',
            },
            request.status as ApprovalInstanceStatus,
            false,
            auditActor.system('SYSTEM', 'bootstrap:repairImportedWeeks'),
          ),
        );
        this.logger.log(
          `Đã xử lý tuần đồng bộ #${batch.id} theo Approval ${request.status}`,
        );
      } catch (error: any) {
        this.logger.warn(
          `Không xử lý được tuần đồng bộ #${batch.id}: ${error?.message}`,
        );
      }
    }
  }

  /**
   * `actor`: ai đưa trạng thái Lark về POS (webhook, cron, ...) để ghi lịch sử;
   * mọi bước quỹ / phiếu của lần cập nhật này dùng chung actor (và opId).
   */
  private async refreshFromLark(
    requestId: number,
    instanceCode: string,
    status: ApprovalInstanceStatus,
    actor: AuditActor,
    eventTime?: Date | null,
    knownDetail?: any,
    eventUuid?: string,
  ) {
    await this.applyLarkStatus(
      requestId,
      instanceCode,
      status,
      actor,
      eventTime,
      knownDetail,
      eventUuid,
    );
    await this.syncLarkEntry(requestId, actor);
  }

  private async applyLarkStatus(
    requestId: number,
    instanceCode: string,
    status: ApprovalInstanceStatus,
    actor: AuditActor,
    eventTime?: Date | null,
    knownDetail?: any,
    eventUuid?: string,
  ) {
    const hint = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
      select: { status: true, lastEventAt: true },
    });
    if (!hint) return;
    if (
      eventTime &&
      hint.lastEventAt &&
      eventTime.getTime() < hint.lastEventAt.getTime()
    ) {
      return;
    }
    const hintRank =
      APPROVAL_STATUS_ORDER[hint.status as ApprovalInstanceStatus] || 0;
    const nextRank = APPROVAL_STATUS_ORDER[status] || 0;
    if (hint.status === 'REVERTED') return;
    if (status === 'REVERTED' && hint.status !== 'APPROVED') return;
    if (nextRank < hintRank) return;
    if (
      nextRank === hintRank &&
      hint.status !== status &&
      hint.status !== 'PENDING'
    ) {
      return;
    }

    let detail = knownDetail || null;
    if (!detail && status !== 'DELETED') {
      try {
        detail = await this.getInstance(instanceCode);
      } catch (error: any) {
        if (status === 'PENDING') throw error;
        this.logger.warn(
          `Không lấy được Approval detail ${instanceCode} khi cập nhật ${status}: ${error?.message}`,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await this.fundLedger.lockApproval(tx, requestId);
      const current = await tx.approvalRequest.findUnique({
        where: { id: requestId },
        select: {
          status: true,
          lastEventAt: true,
          sourceType: true,
          sourceId: true,
          clientUuid: true,
          branchId: true,
          kind: true,
          createdById: true,
          instanceCode: true,
        },
      });
      if (!current) return;

      if (
        eventTime &&
        current.lastEventAt &&
        eventTime.getTime() < current.lastEventAt.getTime()
      ) {
        return;
      }

      const currentRank =
        APPROVAL_STATUS_ORDER[current.status as ApprovalInstanceStatus] || 0;
      const nextRank = APPROVAL_STATUS_ORDER[status] || 0;
      if (current.status === 'REVERTED') return;
      if (status === 'REVERTED' && current.status !== 'APPROVED') return;
      if (nextRank < currentRank) return;
      if (
        nextRank === currentRank &&
        current.status !== status &&
        current.status !== 'PENDING'
      ) {
        return;
      }

      const currentNode = this.getCurrentNode(detail);
      const data: any = {
        status,
        currentNode,
        lastEventUuid: eventUuid,
        lastEventAt: eventTime || new Date(),
        completedAt: status === 'PENDING' ? undefined : eventTime || new Date(),
        ...(detail ? { detailSnapshot: detail } : {}),
      };

      // Lịch sử: chỉ ghi khi trạng thái lưu thật sự đổi (sự kiện lặp lại / cron
      // hỏi lại cùng trạng thái không ghi gì), trong cùng transaction.
      const by = actor.onBehalfOfUserId
        ? actor
        : onBehalfOf(actor, await this.requesterOf(tx, current));
      const statusBefore = String(current.status);
      const updateRequest = async (metadata?: Record<string, unknown>) => {
        const updated = await tx.approvalRequest.update({
          where: { id: requestId },
          data,
        });
        if (statusBefore !== status)
          await this.financeAudit.write(
            tx,
            this.approvalStatusEntry(
              {
                ...current,
                ...(updated as Partial<ApprovalAuditRow> | undefined),
                id: requestId,
              },
              statusBefore,
              status,
              by,
              {
                eventUuid: eventUuid ?? null,
                eventTime: eventTime ?? null,
                currentNode,
                ...metadata,
              },
            ),
          );
        return updated;
      };

      // Chuyển tiền giữa 2 quỹ: mỗi bên xét mốc lên POS của chính quỹ đó.
      const transferSkip =
        isLarkCreated(current.clientUuid) &&
        status === 'APPROVED' &&
        data.completedAt &&
        current.sourceType === 'INTERNAL_FUND_TRANSFER'
          ? await this.transferLegsBeforeCutoff(
              tx,
              current.sourceId,
              data.completedAt,
            )
          : null;

      // Đơn tạo trên Lark mà sổ quỹ Lark đã ghi tiền (duyệt trước ngày dùng POS
      // của chi nhánh, hoặc sổ đã có dòng trùng): chỉ cập nhật trạng thái,
      // không ghi quỹ lần 2.
      if (
        isLarkCreated(current.clientUuid) &&
        status === 'APPROVED' &&
        data.completedAt &&
        (transferSkip
          ? transferSkip.length === 2
          : data.completedAt.getTime() <
              larkFundCutoff(current.branchId, current.sourceType).getTime() ||
            (await this.ledgerHasLarkOrder(tx, requestId, data.completedAt)))
      ) {
        await updateRequest({ fundRecordedOnLarkLedger: true });
        return;
      }

      if (
        ['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'].includes(
          current.sourceType || '',
        )
      ) {
        const updated = await updateRequest(
          transferSkip?.length ? { skipBranchIds: transferSkip } : undefined,
        );
        await this.fundLedger.applyApproval(tx, updated, {
          skipBranchIds: transferSkip ?? [],
          auditActor: by,
        });
        return;
      }

      if (current.sourceType === PAYMENT_VOUCHER.sourceType) {
        const updated = await updateRequest();
        await this.fundLedger.applyPaymentVoucher(tx, updated, by);
        return;
      }

      if (current.sourceType === SALARY_ADVANCE.sourceType) {
        const updated = await updateRequest();
        await this.fundLedger.applySalaryAdvance(tx, updated, by);
        return;
      }

      if (
        !WEEKLY_SOURCE_TYPES.includes(current.sourceType || '') ||
        !current.sourceId
      ) {
        await updateRequest();
        return;
      }

      const wasApproved = current.status === 'APPROVED';
      await this.applyWeeklyBatchStatus(
        tx,
        {
          id: requestId,
          sourceId: current.sourceId,
          sourceType: current.sourceType,
        },
        status,
        wasApproved,
        by,
        () => updateRequest(),
      );
    });
  }

  /**
   * Đơn duyệt tuần đổi trạng thái: cập nhật batch và phiếu chi; kho thì duyệt
   * xong tự ghi quỹ + tick Đã chi, bị thu hồi thì rút lại. Dùng cho cả tuần tạo
   * trên POS lẫn tuần đồng bộ từ Lark khi còn đang chờ duyệt.
   */
  private async applyWeeklyBatchStatus(
    tx: Prisma.TransactionClient,
    request: { id: number; sourceId: number; sourceType?: string | null },
    status: ApprovalInstanceStatus,
    wasApproved: boolean,
    actor: AuditActor,
    updateRequest?: () => Promise<unknown>,
  ) {
    const batch = await tx.internalFinanceWeeklyBatch.findUnique({
      where: { id: request.sourceId },
      select: { branchId: true, createdBy: true, status: true, code: true },
    });
    if (batch) await this.fundLedger.lock(tx, [batch.branchId]);
    if (updateRequest) await updateRequest();
    // Batch đã hủy: chỉ ghi nhận trạng thái đơn, không đụng phiếu.
    if (batch?.status === 'CANCELLED') return;

    // Lark từ chối / thu hồi / xóa đơn chưa duyệt: tự hủy batch như nút Hủy
    // (giữ batch "Đã hủy" kèm lý do, phiếu trả về Phiếu chi kho để gom lại).
    if (
      batch &&
      !wasApproved &&
      ['REJECTED', 'CANCELED', 'DELETED'].includes(status)
    ) {
      const snapshot = await tx.approvalRequest.findUnique({
        where: { id: request.id },
        select: { detailSnapshot: true },
      });
      const comment = endingStep(
        approvalHistory(snapshot?.detailSnapshot),
      )?.comment;
      const label =
        status === 'REJECTED'
          ? 'Lark Approval từ chối'
          : status === 'CANCELED'
            ? 'Người gửi thu hồi Approval Lark'
            : 'Approval Lark đã bị xóa';
      await cancelWeeklyBatchInTx(
        tx,
        request.sourceId,
        {
          cancelledBy: null,
          reason: comment ? `${label}: ${comment}` : label,
          actor,
        },
        this.financeAudit,
      );
      return;
    }

    // Lịch sử của batch / phiếu: ghi trong cùng transaction, chỉ dòng đổi thật.
    const logs: FinanceAuditEntry[] = [];
    const batchCode = batch?.code ?? `#${request.sourceId}`;
    const auditMeta = {
      batchId: request.sourceId,
      approvalRequestId: request.id,
      approvalStatus: status,
    };

    // Tuần Kho HN đồng bộ từ Lark được gắn phiếu theo khoảng ngày: chỉ phiếu đã
    // được Quản lý kho và Kế toán kho đồng kiểm mới thuộc approval, phiếu còn lại
    // trả về chờ kiểm tra. Kho SG trên Lark không dùng hai tick nên approval
    // gồm mọi phiếu của tuần.
    if (
      batch?.branchId === 6 &&
      status === 'APPROVED' &&
      request.sourceType === 'LARK_IMPORT_WEEKLY'
    ) {
      const where = {
        weeklyBatchId: request.sourceId,
        cashIssued: false,
        cashFlowId: null,
        OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
      };
      const dropped: EntryAuditRow[] = await tx.internalFinanceEntry.findMany({
        where,
        select: ENTRY_AUDIT_SELECT,
      });
      await tx.internalFinanceEntry.updateMany({
        where,
        data: { weeklyBatchId: null, status: 'PENDING_ACCOUNTANT' },
      });
      const reason = 'Chưa đủ tick Quản lý kho và Kế toán kho khi Lark duyệt';
      for (const entry of dropped ?? [])
        logs.push({
          action: 'FIN_ENTRY_BATCH_REMOVE',
          entityType: FINANCE_AUDIT_ENTITY.ENTRY,
          entityId: entry.id,
          entityCode: entry.code,
          branchId: entry.branchId,
          actor,
          params: {
            code: entry.code,
            batchCode,
            reasonSuffix: reasonSuffix(reason),
          },
          changes: [
            {
              field: 'weeklyBatchId',
              label: 'Approval tuần',
              from: batchCode,
              to: '—',
              type: 'field_changed',
              detail: { from: request.sourceId, to: null },
            },
            ...this.financeAudit.diff(
              FINANCE_AUDIT_ENTITY.ENTRY,
              { status: entry.status },
              { status: 'PENDING_ACCOUNTANT' },
              ['status'],
            ),
          ],
          metadata: { ...auditMeta, statusBefore: entry.status },
        });
    }

    if (batch) {
      const batchStatus =
        status === 'APPROVED'
          ? 'APPROVED'
          : status === 'PENDING'
            ? 'IN_APPROVAL'
            : 'REJECTED';
      const entryStatus =
        status === 'APPROVED'
          ? 'APPROVED'
          : status === 'PENDING'
            ? 'IN_WEEKLY_APPROVAL'
            : 'REJECTED';
      await tx.internalFinanceWeeklyBatch.update({
        where: { id: request.sourceId },
        data: { status: batchStatus },
      });
      if (batch.status !== batchStatus) {
        const changes = this.financeAudit.diff(
          FINANCE_AUDIT_ENTITY.BATCH,
          { status: batch.status },
          { status: batchStatus },
          ['status'],
        );
        logs.push(
          wasApproved && batchStatus !== 'APPROVED'
            ? {
                action: 'FIN_BATCH_LARK_REVERT',
                entityType: FINANCE_AUDIT_ENTITY.BATCH,
                entityId: request.sourceId,
                entityCode: batch.code ?? null,
                branchId: batch.branchId,
                actor,
                params: { batchCode },
                changes,
                metadata: { ...auditMeta, statusBefore: batch.status },
              }
            : {
                action: 'FIN_BATCH_LARK_STATUS',
                entityType: FINANCE_AUDIT_ENTITY.BATCH,
                entityId: request.sourceId,
                entityCode: batch.code ?? null,
                branchId: batch.branchId,
                actor,
                params: {
                  batchCode,
                  statusLabel: batchStatusLabel(batchStatus),
                },
                changes,
                metadata: { ...auditMeta, statusBefore: batch.status },
              },
        );
      }
      const openWhere = {
        weeklyBatchId: request.sourceId,
        cashFlowId: null,
        cashIssued: false,
      };
      logs.push(
        ...(await this.weeklyEntryStatusLogs(
          tx,
          openWhere,
          entryStatus,
          batchCode,
          actor,
          auditMeta,
        )),
      );
      await tx.internalFinanceEntry.updateMany({
        where: openWhere,
        data: { status: entryStatus },
      });
      // Batch + phiếu trước, dòng quỹ (sổ quỹ tự ghi) sau.
      await this.financeAudit.write(tx, logs);
      logs.length = 0;
      // Kho: Approval duyệt thì tự ghi quỹ + tick Đã chi; bị thu hồi thì rút lại.
      if ([1, 6].includes(batch.branchId)) {
        if (status === 'APPROVED') {
          await this.fundLedger.issueApprovedBatch(
            tx,
            request.sourceId,
            request.id,
            batch.createdBy,
            actor,
          );
        } else if (wasApproved) {
          await this.fundLedger.revertApprovedBatch(
            tx,
            request.sourceId,
            request.id,
            batch.createdBy,
            actor,
          );
          // Phiếu vừa bỏ Đã chi cũng về trạng thái của đơn.
          const revertedWhere = {
            weeklyBatchId: request.sourceId,
            cashIssued: false,
          };
          logs.push(
            ...(await this.weeklyEntryStatusLogs(
              tx,
              revertedWhere,
              entryStatus,
              batchCode,
              actor,
              auditMeta,
            )),
          );
          await tx.internalFinanceEntry.updateMany({
            where: revertedWhere,
            data: { status: entryStatus },
          });
        }
      }
    }
    await this.financeAudit.write(tx, logs);
  }

  /**
   * FIN_ENTRY_WEEKLY_STATUS cho các phiếu (theo `where`) sắp đổi sang
   * `entryStatus`; phiếu đã ở trạng thái đó thì bỏ qua. Gọi TRƯỚC updateMany.
   */
  private async weeklyEntryStatusLogs(
    tx: Prisma.TransactionClient,
    where: Prisma.InternalFinanceEntryWhereInput,
    entryStatus: string,
    batchCode: string,
    actor: AuditActor,
    metadata: Record<string, unknown>,
  ): Promise<FinanceAuditEntry[]> {
    const entries: EntryAuditRow[] =
      (await tx.internalFinanceEntry.findMany({
        where,
        select: ENTRY_AUDIT_SELECT,
      })) ?? [];
    return entries
      .filter((entry) => entry.status !== entryStatus)
      .map((entry) => ({
        action: 'FIN_ENTRY_WEEKLY_STATUS',
        entityType: FINANCE_AUDIT_ENTITY.ENTRY,
        entityId: entry.id,
        entityCode: entry.code,
        branchId: entry.branchId,
        actor,
        params: {
          code: entry.code,
          batchCode,
          statusLabel: entryStatusLabel(entryStatus),
        },
        changes: this.financeAudit.diff(
          FINANCE_AUDIT_ENTITY.ENTRY,
          { status: entry.status },
          { status: entryStatus },
          ['status'],
        ),
        metadata: { ...metadata, statusBefore: entry.status },
      }));
  }

  /** Một dòng lịch sử của đơn Approval. */
  private approvalEntry(
    action: ApprovalAuditAction,
    request: ApprovalAuditRow,
    actor: AuditActor,
    extra: {
      params?: FinanceAuditParams;
      changes?: FinanceAuditChange[];
      snapshot?: FinanceAuditSnapshot;
      metadata?: Record<string, unknown>;
    } = {},
  ): FinanceAuditEntry {
    const ref = approvalAuditRef(request);
    return {
      action,
      entityType: FINANCE_AUDIT_ENTITY.APPROVAL,
      entityId: request.id,
      entityCode: ref.entityCode,
      branchId: request.branchId ?? null,
      actor,
      params: { kindLabel: ref.kindLabel, code: ref.code, ...extra.params },
      changes: extra.changes,
      snapshot: extra.snapshot,
      metadata: {
        instanceCode: request.instanceCode ?? null,
        clientUuid: request.clientUuid ?? null,
        sourceType: request.sourceType ?? null,
        sourceId: request.sourceId ?? null,
        ...extra.metadata,
      },
    };
  }

  /** Lark đổi trạng thái đơn: FIN_APPROVAL_STATUS, thu hồi → FIN_APPROVAL_REVERT. */
  private approvalStatusEntry(
    request: ApprovalAuditRow,
    from: string,
    to: ApprovalInstanceStatus,
    actor: AuditActor,
    metadata: Record<string, unknown>,
  ): FinanceAuditEntry {
    const changes = this.statusChanges(from, to);
    const meta = { ...metadata, statusBefore: from, statusAfter: to };
    return to === 'REVERTED'
      ? this.approvalEntry('FIN_APPROVAL_REVERT', request, actor, {
          changes,
          metadata: meta,
        })
      : this.approvalEntry('FIN_APPROVAL_STATUS', request, actor, {
          params: {
            from: approvalStatusLabel(from),
            to: approvalStatusLabel(to),
          },
          changes,
          metadata: meta,
        });
  }

  private statusChanges(from: string | null | undefined, to: string) {
    return this.financeAudit.diff(
      FINANCE_AUDIT_ENTITY.APPROVAL,
      { status: from ?? null },
      { status: to },
      ['status'],
    );
  }

  /** Tóm tắt đơn lúc tạo (loại, quỹ, số tiền, nội dung). */
  private approvalCreateSnapshot(
    request: ApprovalAuditRow,
    amount?: number | null,
    description?: string | null,
  ): FinanceAuditSnapshot {
    const ref = approvalAuditRef(request);
    return {
      lines: [
        { label: 'Loại đơn', value: ref.kindLabel || '—' },
        { label: 'Chi nhánh', value: branchLabel(request.branchId) },
        ...(amount ? [{ label: 'Số tiền', value: formatMoney(amount) }] : []),
        ...(description ? [{ label: 'Nội dung', value: description }] : []),
      ],
      amount: amount ?? null,
    };
  }

  private async getInstance(instanceCode: string) {
    const response = await this.larkClient.approval.v4.instance.get({
      path: { instance_id: instanceCode },
      params: { locale: 'vi-VN', user_id_type: 'open_id' },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(response.msg || `Lark Approval error ${response.code}`);
    }
    return response?.data;
  }

  private getCurrentNode(detail: any): string | null {
    const currentNodes = this.getCurrentNodes(detail);
    const currentNode = currentNodes.find((node: any) => node?.node_name);
    if (currentNode?.node_name) return String(currentNode.node_name);

    const tasks = this.getTaskList(detail);
    const pending = tasks.find((task: any) => task?.status === 'PENDING');
    return pending?.node_name || tasks[tasks.length - 1]?.node_name || null;
  }

  private getTaskList(detail: any): any[] {
    if (Array.isArray(detail?.tasks)) return detail.tasks;
    if (Array.isArray(detail?.task_list)) return detail.task_list;
    return [];
  }

  private getCurrentNodes(detail: any): any[] {
    return Array.isArray(detail?.current_nodes) ? detail.current_nodes : [];
  }

  private getTimeline(detail: any): any[] {
    if (Array.isArray(detail?.operation_records)) {
      return detail.operation_records;
    }
    if (Array.isArray(detail?.operationRecords)) {
      return detail.operationRecords;
    }
    return [];
  }

  private parseKind(value: string): ApprovalRequestKind {
    if (value in APPROVAL_DEFINITIONS) return value as ApprovalRequestKind;
    throw new BadRequestException(
      'kind phải là EXPENSE_HN, EXPENSE_SG, EXPENSE_VP hoặc RECEIPT',
    );
  }

  private parseStatus(value: unknown): ApprovalInstanceStatus | null {
    const status = String(value || '').toUpperCase();
    return status in APPROVAL_STATUS_ORDER
      ? (status as ApprovalInstanceStatus)
      : null;
  }

  private parseEventTime(value?: string) {
    if (!value) return null;
    const millis = Number(value);
    if (!Number.isFinite(millis)) return null;
    return new Date(millis);
  }

  private validateForm(
    kind: ApprovalRequestKind,
    form: ApprovalFormItem[],
    branchId?: number,
  ) {
    const definition = APPROVAL_DEFINITIONS[kind];
    const byId = new Map(form.map((item) => [item.id, item]));
    const missing = definition.requiredFieldIds.filter((id) => {
      const value = byId.get(id)?.value;
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      throw new BadRequestException(
        `Thiếu field Approval bắt buộc: ${missing.join(', ')}`,
      );
    }

    if (kind !== 'RECEIPT') {
      if (!this.isValidExpenseBranch(kind, branchId)) {
        throw new BadRequestException('Branch không khớp với loại Approval');
      }
      const periodIds =
        kind === 'EXPENSE_HN'
          ? EXPENSE_FIELD_IDS.HN
          : kind === 'EXPENSE_SG'
            ? EXPENSE_FIELD_IDS.SG
            : EXPENSE_FIELD_IDS.VP;
      this.validateDateRange(
        byId.get(periodIds.from)?.value,
        byId.get(periodIds.to)?.value,
        'Kỳ chi',
      );
    } else if (!branchId) {
      throw new BadRequestException('Phiếu Thu phải có branchId của quỹ');
    }

    const amount = this.toNumber(
      byId.get(EXPENSE_FIELD_IDS.common.amount)?.value,
    );
    const receiptAmount = this.toNumber(
      byId.get(RECEIPT_FIELD_IDS.amount)?.value,
    );
    if (
      (kind !== 'RECEIPT' && amount <= 0) ||
      (kind === 'RECEIPT' && receiptAmount <= 0)
    ) {
      throw new BadRequestException('Số tiền Approval phải lớn hơn 0');
    }

    if (kind === 'EXPENSE_VP') {
      const method = this.stringValue(
        byId.get(EXPENSE_FIELD_IDS.VP.method)?.value,
      );
      const source = this.stringValue(
        byId.get(EXPENSE_FIELD_IDS.VP.cashSource)?.value,
      );
      if (!EXPENSE_VP_OPTIONS.methods.has(method)) {
        throw new BadRequestException('Phương thức thanh toán VP không hợp lệ');
      }
      if (method === EXPENSE_VP_OPTIONS.cashMethod) {
        if (!this.hasValue(source)) {
          throw new BadRequestException(
            'Phiếu Chi VP tiền mặt phải có Nguồn Tiền Mặt',
          );
        }
        if (!EXPENSE_VP_OPTIONS.cashSources.has(source)) {
          throw new BadRequestException('Nguồn tiền mặt VP không hợp lệ');
        }
        if (
          branchId &&
          APPROVAL_BRANCHES.EXPENSE_VP.has(branchId) &&
          EXPENSE_VP_OPTIONS.branchCashSources[branchId] !== source
        ) {
          throw new BadRequestException(
            'Nguồn tiền mặt VP không khớp chi nhánh',
          );
        }
      }
    }

    if (kind === 'RECEIPT') this.validateReceiptForm(byId);
  }

  private isValidExpenseBranch(
    kind: Exclude<ApprovalRequestKind, 'RECEIPT'>,
    branchId?: number,
  ) {
    if (kind === 'EXPENSE_HN') return branchId === APPROVAL_BRANCHES.EXPENSE_HN;
    if (kind === 'EXPENSE_SG') return branchId === APPROVAL_BRANCHES.EXPENSE_SG;
    return branchId !== undefined && APPROVAL_BRANCHES.EXPENSE_VP.has(branchId);
  }

  private validateReceiptForm(byId: Map<string, ApprovalFormItem>) {
    const classification = this.stringValue(
      byId.get(RECEIPT_FIELD_IDS.classification)?.value,
    );
    const method = this.stringValue(byId.get(RECEIPT_FIELD_IDS.method)?.value);

    if (
      !Object.values(RECEIPT_OPTIONS.classifications).includes(
        classification as any,
      )
    ) {
      throw new BadRequestException('Phân loại Phiếu Thu không hợp lệ');
    }
    if (!Object.values(RECEIPT_OPTIONS.methods).includes(method as any)) {
      throw new BadRequestException('Hình thức thu không hợp lệ');
    }
    if (!this.hasValue(byId.get(RECEIPT_FIELD_IDS.invoiceFiles)?.value)) {
      throw new BadRequestException(
        'Phiếu Thu phải có ít nhất một file Hóa đơn',
      );
    }

    if (classification === RECEIPT_OPTIONS.classifications.internalTransfer) {
      if (
        !this.hasValue(byId.get(RECEIPT_FIELD_IDS.from)?.value) ||
        !this.hasValue(byId.get(RECEIPT_FIELD_IDS.to)?.value)
      ) {
        throw new BadRequestException(
          'Phiếu Thu chuyển tiền nội bộ phải có Nơi đi và Nơi nhận',
        );
      }
      const from = this.stringValue(byId.get(RECEIPT_FIELD_IDS.from)?.value);
      const to = this.stringValue(byId.get(RECEIPT_FIELD_IDS.to)?.value);
      const sourceBranchId =
        RECEIPT_LOCATION_BRANCHES.from[
          from as keyof typeof RECEIPT_LOCATION_BRANCHES.from
        ];
      const destinationBranchId =
        RECEIPT_LOCATION_BRANCHES.to[
          to as keyof typeof RECEIPT_LOCATION_BRANCHES.to
        ];
      if (!sourceBranchId || !destinationBranchId) {
        throw new BadRequestException(
          'Nơi đi hoặc Nơi nhận của Phiếu Thu không hợp lệ',
        );
      }
      if (sourceBranchId === destinationBranchId) {
        throw new BadRequestException(
          'Nơi đi và Nơi nhận của Phiếu Thu không được trùng nhau',
        );
      }
    }

    if (method === RECEIPT_OPTIONS.methods.cash) {
      const source = this.stringValue(
        byId.get(RECEIPT_FIELD_IDS.cashSource)?.value,
      );
      if (!RECEIPT_OPTIONS.cashSources.has(source)) {
        throw new BadRequestException(
          'Phiếu Thu tiền mặt phải có Nguồn Tiền Mặt',
        );
      }
    }

    if (
      classification === RECEIPT_OPTIONS.classifications.refundAdvance &&
      !this.hasValue(byId.get(RECEIPT_FIELD_IDS.tempAdvance)?.value)
    ) {
      throw new BadRequestException(
        'Phiếu Thu hoàn trả tạm ứng phải có phiếu tạm ứng liên quan',
      );
    }

    if (!this.parseDateOnly(byId.get(RECEIPT_FIELD_IDS.date)?.value)) {
      throw new BadRequestException('Ngày thu không hợp lệ');
    }
  }

  private hasValue(value: unknown) {
    if (value === undefined || value === null || value === '') return false;
    return Array.isArray(value) ? value.length > 0 : true;
  }

  private stringValue(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] || '');
    if (value && typeof value === 'object' && 'value' in value) {
      return String((value as any).value || '');
    }
    return String(value || '');
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private parseDateOnly(value: unknown): Date | null {
    const text = this.stringValue(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10) === text ? date : null;
  }

  private validateDateRange(
    fromValue: unknown,
    toValue: unknown,
    label: string,
  ) {
    const from = this.parseDateOnly(fromValue);
    const to = this.parseDateOnly(toValue);
    if (!from || !to) {
      throw new BadRequestException(`${label} phải là ngày hợp lệ`);
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException(
        `${label} có ngày bắt đầu không được sau ngày kết thúc`,
      );
    }
  }

  private larkText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value
        .map((item) =>
          typeof item === 'string' || typeof item === 'number'
            ? String(item)
            : item && typeof item === 'object' && 'text' in item
              ? String((item as any).text || '')
              : '',
        )
        .join('');
    }
    if (typeof value === 'object' && 'text' in value) {
      return String((value as any).text || '');
    }
    return '';
  }

  private serializeRequest(request: any) {
    const detail =
      request.detailSnapshot &&
      typeof request.detailSnapshot === 'object' &&
      !Array.isArray(request.detailSnapshot)
        ? request.detailSnapshot
        : null;
    const currentNodes = this.getCurrentNodes(detail);
    const currentApprovers = currentNodes.flatMap((node: any) =>
      Array.isArray(node?.approvers)
        ? node.approvers.map((approver: any) => ({
            taskId: approver?.task_id || null,
            userId: approver?.user_id || null,
          }))
        : [],
    );
    return {
      id: request.id,
      kind: request.kind,
      approvalCode: request.approvalCode,
      instanceCode: request.instanceCode,
      clientUuid: request.clientUuid,
      status: request.status,
      currentNode: request.currentNode,
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      branchId: request.branchId,
      cashFlowId: request.cashFlowId,
      instanceLink: detail?.instance_link || null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      completedAt: request.completedAt,
      taskList: this.getTaskList(detail),
      currentNodes,
      currentApprovers,
      timeline: this.getTimeline(detail),
      events: request.events,
    };
  }
}
