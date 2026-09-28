import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import { CashFlowsService } from '../cashflows/cashflows.service';
import {
  APPROVAL_DEFINITIONS,
  APPROVAL_BRANCHES,
  APPROVAL_FORM_VERSION,
  APPROVAL_STATUS_ORDER,
  EXPENSE_VP_OPTIONS,
  RECEIPT_FIELD_IDS,
  RECEIPT_LOCATION_BRANCHES,
  RECEIPT_OPTIONS,
  type ApprovalFormItem,
  type ApprovalInstanceStatus,
  type ApprovalRequestKind,
} from './approval-lifecycle.constants';
import type { CreateApprovalRequestDto } from './dto/create-approval-request.dto';
import type { ApprovalRequestQueryDto } from './dto/approval-request-query.dto';

type ApprovalEvent = {
  approval_code?: string;
  instance_code?: string;
  status?: string;
  instance_operate_time?: string;
  uuid?: string;
};

@Injectable()
export class ApprovalLifecycleService {
  private readonly logger = new Logger(ApprovalLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
    private readonly cashFlowsService: CashFlowsService,
  ) {}

  async create(dto: CreateApprovalRequestDto, userId: number) {
    const kind = this.parseKind(dto.kind);
    const definition = APPROVAL_DEFINITIONS[kind];
    const clientUuid = dto.clientUuid?.trim() || randomUUID();
    if (clientUuid.length > 64) {
      throw new BadRequestException('clientUuid không được vượt quá 64 ký tự');
    }

    const existing = await this.prisma.approvalRequest.findUnique({
      where: { clientUuid },
    });
    if (existing && existing.instanceCode) return this.serializeRequest(existing);
    if (existing && existing.status !== 'CREATE_FAILED') {
      return this.serializeRequest(existing);
    }

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
      JSON.stringify({ version: APPROVAL_FORM_VERSION, form }),
    ) as Prisma.InputJsonValue;

    const request = existing
      ? await this.prisma.approvalRequest.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            formSnapshot,
          },
        })
      : await this.prisma.approvalRequest.create({
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
      await this.replayOrphanEvents(updated.id, instanceCode);
      return this.serializeRequest(updated);
    } catch (error: any) {
      await this.prisma.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: 'CREATE_FAILED',
          detailSnapshot: {
            error: error?.message || 'Không tạo được Approval',
          },
        },
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
    if (!request) throw new NotFoundException('Không tìm thấy yêu cầu Approval');
    return this.serializeRequest(request);
  }

  async findAll(query: ApprovalRequestQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = {};
    if (query.kind) where.kind = query.kind;
    if (query.status) where.status = query.status;
    if (query.branchId) where.branchId = query.branchId;
    if (query.search) {
      where.OR = [
        { clientUuid: { contains: query.search, mode: 'insensitive' } },
        { instanceCode: { contains: query.search, mode: 'insensitive' } },
      ];
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
            `${item.label} ${item.content}`
              .toLowerCase()
              .includes(needle)),
      )
      .slice(0, 50);

    return { data: items };
  }

  async uploadFile(
    file: Express.Multer.File | undefined,
    type: string,
  ) {
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
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Không tìm thấy yêu cầu Approval');
    if (request.status !== 'APPROVED') {
      throw new BadRequestException(
        'Chỉ được liên kết dòng tiền sau khi Approval đã được duyệt',
      );
    }
    if (request.cashFlowId) {
      if (request.cashFlowId === cashFlowId) return this.serializeRequest(request);
      throw new BadRequestException('Approval đã được liên kết với dòng tiền khác');
    }

    const cashFlow = await this.prisma.cashFlow.findUnique({
      where: { id: cashFlowId },
      select: { id: true, branchId: true },
    });
    if (!cashFlow) throw new NotFoundException('Không tìm thấy dòng tiền');
    if (request.branchId && request.branchId !== cashFlow.branchId) {
      throw new BadRequestException(
        'Chi nhánh của Approval không khớp chi nhánh dòng tiền',
      );
    }

    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: { cashFlowId },
    });
    return this.serializeRequest(updated);
  }

  async postCashFlow(id: number, userId: number) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Không tìm thấy yêu cầu Approval');
    if (request.status !== 'APPROVED') {
      throw new BadRequestException(
        'Chỉ được ghi nhận tiền sau khi Approval đã được duyệt',
      );
    }
    if (!request.branchId) {
      throw new BadRequestException('Approval chưa có branchId');
    }

    const snapshot = request.formSnapshot as any;
    const form = Array.isArray(snapshot?.form) ? snapshot.form : [];
    const byId = new Map<string, any>(
      form.map((item: any) => [item.id, item]),
    );
    const amount = this.toNumber(
      request.kind === 'RECEIPT'
        ? byId.get(RECEIPT_FIELD_IDS.amount)?.value
        : byId.get('widget17368415755750001')?.value,
    );
    if (amount <= 0) throw new BadRequestException('Approval không có số tiền hợp lệ');

    const dateValue =
      request.kind === 'RECEIPT'
        ? byId.get(RECEIPT_FIELD_IDS.date)?.value
        : byId.get(
            request.kind === 'EXPENSE_HN'
              ? 'widget17399508033270001'
              : 'widget17399508904720001',
          )?.value;
    const description =
      (request.kind === 'RECEIPT'
        ? this.stringValue(byId.get(RECEIPT_FIELD_IDS.description)?.value)
        : this.stringValue(
            byId.get('widget17368416610880001')?.value,
          )) || `Approval ${request.instanceCode || request.id}`;

    if (request.kind === 'RECEIPT') {
      const receiptMethod =
        this.stringValue(byId.get(RECEIPT_FIELD_IDS.method)?.value) ===
        RECEIPT_OPTIONS.methods.cash
          ? 'cash'
          : 'transfer';
      const classification = this.stringValue(
        byId.get(RECEIPT_FIELD_IDS.classification)?.value,
      );
      if (classification === RECEIPT_OPTIONS.classifications.internalTransfer) {
        const sourceBranchId =
          RECEIPT_LOCATION_BRANCHES.from[
            this.stringValue(byId.get(RECEIPT_FIELD_IDS.from)?.value) as keyof typeof RECEIPT_LOCATION_BRANCHES.from
          ];
        const destinationBranchId =
          RECEIPT_LOCATION_BRANCHES.to[
            this.stringValue(byId.get(RECEIPT_FIELD_IDS.to)?.value) as keyof typeof RECEIPT_LOCATION_BRANCHES.to
          ];
        if (!sourceBranchId || !destinationBranchId) {
          throw new BadRequestException(
            'Phiếu Thu chuyển tiền nội bộ chưa map được chi nhánh',
          );
        }
        return this.cashFlowsService.createApprovalTransferCashFlows(
          {
            approvalRequestId: id,
            sourceBranchId,
            destinationBranchId,
            amount,
            transDate: dateValue ? String(dateValue) : undefined,
            description,
            method: receiptMethod,
          },
          userId,
        );
      }

      return this.cashFlowsService.createApprovalCashFlow(
        {
          approvalRequestId: id,
          branchId: request.branchId,
          amount,
          transDate: dateValue ? String(dateValue) : undefined,
          description,
          method: receiptMethod,
          isReceipt: true,
        },
        userId,
      );
    }

    let method = 'cash';
    if (request.kind === 'EXPENSE_VP') {
      const vpMethod = this.stringValue(
        byId.get('widget17700954766870001')?.value,
      );
      if (vpMethod === 'ml65570v-qr4uobqvu9-0') {
        throw new BadRequestException(
          'Phiếu Chi VP chuyển khoản không làm giảm quỹ tiền mặt',
        );
      }
      method = 'cash';
    }

    return this.cashFlowsService.createApprovalCashFlow(
      {
        approvalRequestId: id,
        branchId: request.branchId,
        amount,
        transDate: dateValue ? String(dateValue) : undefined,
        description,
        method,
        isReceipt: false,
      },
      userId,
    );
  }

  async handleInstanceEvent(event: ApprovalEvent) {
    const instanceCode = String(event.instance_code || '').trim();
    const approvalCode = String(event.approval_code || '').trim();
    const status = this.parseStatus(event.status);
    if (!instanceCode || !approvalCode || !status) {
      this.logger.warn('Bỏ qua approval event thiếu instance_code/approval_code/status');
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

    let storedEvent: { id: number };
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
        select: { id: true },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') return;
      throw error;
    }

    if (!matchedRequest) {
      await this.prisma.approvalRequestEvent.update({
        where: { id: storedEvent.id },
        data: { error: 'Không tìm thấy approval request tương ứng' },
      });
      this.logger.warn(`Approval event không có request POS: ${instanceCode}`);
      return;
    }

    try {
      await this.refreshFromLark(
        matchedRequest.id,
        instanceCode,
        status,
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

  private async replayOrphanEvents(requestId: number, instanceCode: string) {
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

  private async refreshFromLark(
    requestId: number,
    instanceCode: string,
    status: ApprovalInstanceStatus,
    eventTime?: Date | null,
    knownDetail?: any,
    eventUuid?: string,
  ) {
    const current = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
      select: { status: true, lastEventAt: true },
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
    if (
      status === 'REVERTED' &&
      current.status !== 'APPROVED'
    ) {
      return;
    }
    if (nextRank < currentRank) return;
    if (
      nextRank === currentRank &&
      current.status !== status &&
      current.status !== 'PENDING'
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
    const currentNode = this.getCurrentNode(detail);
    const completedAt =
      status === 'PENDING' ? undefined : eventTime || new Date();
    const data: any = {
      status,
      currentNode,
      lastEventUuid: eventUuid,
      lastEventAt: eventTime || new Date(),
      completedAt,
    };
    if (detail) data.detailSnapshot = detail;

    await this.prisma.approvalRequest.update({
      where: { id: requestId },
      data,
    });
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
          ? {
              from: 'widget17399508033270001',
              to: 'widget17399508090490001',
            }
          : {
              from: 'widget17399508904720001',
              to: 'widget17399508961760001',
            };
      this.validateDateRange(
        byId.get(periodIds.from)?.value,
        byId.get(periodIds.to)?.value,
        'Kỳ chi',
      );
    } else if (!branchId) {
      throw new BadRequestException('Phiếu Thu phải có branchId của quỹ');
    }

    const amount = this.toNumber(byId.get('widget17368415755750001')?.value);
    const receiptAmount = this.toNumber(
      byId.get(RECEIPT_FIELD_IDS.amount)?.value,
    );
    if ((kind !== 'RECEIPT' && amount <= 0) || (kind === 'RECEIPT' && receiptAmount <= 0)) {
      throw new BadRequestException('Số tiền Approval phải lớn hơn 0');
    }

    if (kind === 'EXPENSE_VP') {
      const method = this.stringValue(
        byId.get('widget17700954766870001')?.value,
      );
      const source = this.stringValue(
        byId.get('widget17700955853050001')?.value,
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
          (branchId === 4 || branchId === 5 || branchId === 7) &&
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

    if (!Object.values(RECEIPT_OPTIONS.classifications).includes(classification as any)) {
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
      const from = this.stringValue(
        byId.get(RECEIPT_FIELD_IDS.from)?.value,
      );
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
        throw new BadRequestException('Phiếu Thu tiền mặt phải có Nguồn Tiền Mặt');
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

    if (
      !this.parseDateOnly(byId.get(RECEIPT_FIELD_IDS.date)?.value)
    ) {
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
