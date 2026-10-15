import { Inject, Injectable, Logger } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import { InternalFundLedgerService } from '../internal-fund/internal-fund-ledger.service';
import { InternalFinanceCodeService } from '../internal-finance/internal-finance-code.service';
import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_EVIDENCE_STATUS,
  INTERNAL_FINANCE_STATUS,
  LARK_APPROVAL_SOURCE_TYPE,
} from '../internal-finance/internal-finance.constants';
import {
  LARK_LEDGER_CUTOFF,
  summarizeLarkInstance,
  type ApprovalFormItem,
  type LarkFormKind,
  type LarkInstanceSummary,
} from './approval-lifecycle.constants';

/** Lý do Đã chi / Đã thu của phiếu sinh từ đơn Lark đã duyệt. */
export const LARK_APPROVED_REASON = 'Đã duyệt trên Lark Approval';
export const LARK_REVOKED_REASON = 'Đơn bị thu hồi trên Lark Approval';

const DAY = 86400000;

export interface LarkMirrorResult {
  summary: LarkInstanceSummary;
  suspectDuplicateOfId: number | null;
}

/**
 * Lưu bản sao đơn Lark do nhân viên tạo, và tạo / hủy dòng thu chi ở Tài
 * chính nội bộ khi đơn tiền mặt Kho HN / Kho SG được duyệt hoặc thu hồi (không
 * vào Phiếu chi kho). Không gọi lại webhook hay tự đổi trạng thái đơn.
 */
@Injectable()
export class LarkApprovalMirrorService {
  private readonly logger = new Logger(LarkApprovalMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
    private readonly fundLedger: InternalFundLedgerService,
    private readonly codeService: InternalFinanceCodeService,
  ) {}

  /** Mã đơn của một form trong khoảng thời gian (theo ngày tạo đơn). */
  async listInstanceCodes(approvalCode: string, from: Date, to: Date) {
    const codes: string[] = [];
    // Lark giới hạn khoảng thời gian mỗi lần gọi: chia cửa sổ 30 ngày.
    for (let start = from.getTime(); start < to.getTime(); start += 30 * DAY) {
      const end = Math.min(start + 30 * DAY, to.getTime());
      let pageToken: string | undefined;
      do {
        // SDK không có hàm cho API này: gọi thẳng GET /approval/v4/instances.
        // Lark thỉnh thoảng trả 503 / giới hạn tần suất: thử lại, chờ lâu dần.
        const token = pageToken;
        const response: any = await retryLark(async () => {
          const result: any = await this.larkClient.request({
            method: 'GET',
            url: '/open-apis/approval/v4/instances',
            params: {
              approval_code: approvalCode,
              start_time: String(start),
              end_time: String(end),
              page_size: 100,
              ...(token ? { page_token: token } : {}),
            },
          });
          if (result?.code && result.code !== 0)
            throw Object.assign(
              new Error(result.msg || `Lark Approval error ${result.code}`),
              { response: { data: { code: result.code } } },
            );
          return result;
        });
        codes.push(...(response?.data?.instance_code_list || []));
        pageToken = response?.data?.has_more
          ? response.data.page_token
          : undefined;
        await new Promise((resolve) => setTimeout(resolve, 400));
      } while (pageToken);
    }
    return [...new Set(codes)];
  }

  /** Đọc đơn và tìm phiếu POS có thể trùng; không ghi gì. */
  async inspect(kind: LarkFormKind, detail: any): Promise<LarkMirrorResult> {
    const form = parseForm(detail?.form);
    const fallback = larkTime(detail?.end_time) || larkTime(detail?.start_time);
    const summary = summarizeLarkInstance(kind, form, fallback);
    const suspectDuplicateOfId =
      summary.inScope && summary.direction === 'EXPENSE'
        ? await this.findSuspectDuplicate(summary)
        : null;
    return { summary, suspectDuplicateOfId };
  }

  async save(input: {
    instanceCode: string;
    approvalCode: string;
    kind: LarkFormKind;
    detail: any;
    approvalRequestId?: number | null;
    inspected?: LarkMirrorResult;
  }) {
    const { summary, suspectDuplicateOfId } =
      input.inspected || (await this.inspect(input.kind, input.detail));
    const detail = input.detail || {};
    const requester = detail.open_id
      ? await this.prisma.user.findFirst({
          where: { larkUserId: String(detail.open_id) },
          select: { id: true, name: true },
        })
      : null;
    const data = {
      approvalCode: input.approvalCode,
      formKind: input.kind,
      status: String(detail.status || 'PENDING').toUpperCase(),
      serialNumber: detail.serial_number ? String(detail.serial_number) : null,
      requesterId: requester?.id ?? null,
      requesterName: requester?.name ?? null,
      submittedAt: larkTime(detail.start_time),
      completedAt: larkTime(detail.end_time),
      amount: summary.amount,
      cashAmount: summary.cashAmount,
      method: summary.method,
      cashSource: summary.cashSource,
      description: summary.description,
      occurredAt: summary.occurredAt,
      branchId: summary.branchId,
      direction: summary.direction,
      inScope: summary.inScope,
      skipReason: summary.skipReason,
      suspectDuplicateOfId,
      detailSnapshot: detail as Prisma.InputJsonValue,
      syncedAt: new Date(),
      ...(input.approvalRequestId !== undefined
        ? { approvalRequestId: input.approvalRequestId }
        : {}),
    };
    return this.prisma.larkApprovalInstance.upsert({
      where: { instanceCode: input.instanceCode },
      create: { instanceCode: input.instanceCode, ...data },
      update: data,
    });
  }

  /**
   * Sổ quỹ Lark Base (chép vào Quỹ nội bộ) đã có khoản này chưa: cùng kho, cùng
   * chiều thu / chi, cùng số tiền, lệch tối đa ~1 ngày.
   */
  async hasLedgerTwin(
    db: Prisma.TransactionClient | PrismaService,
    input: {
      branchId: number;
      receipt: boolean;
      amount: number;
      at: Date;
    },
  ) {
    const span = 36 * 3600000;
    const twin = await db.internalFundTransaction.findFirst({
      where: {
        branchId: input.branchId,
        sourceType: 'LEDGER_HISTORY',
        status: 'POSTED',
        transactionType: input.receipt ? 'RECEIPT' : 'EXPENSE',
        amount: input.amount,
        occurredAt: {
          gte: new Date(input.at.getTime() - span),
          lte: new Date(input.at.getTime() + span),
        },
      },
      select: { id: true },
    });
    return Boolean(twin);
  }

  linkRequest(instanceCode: string, approvalRequestId: number) {
    return this.prisma.larkApprovalInstance.update({
      where: { instanceCode },
      data: { approvalRequestId },
    });
  }

  /** Đơn đã có kết quả (không còn chờ duyệt) trong danh sách mã. */
  async settledCodes(instanceCodes: string[]) {
    const rows = await this.prisma.larkApprovalInstance.findMany({
      where: {
        instanceCode: { in: instanceCodes },
        status: { not: 'PENDING' },
      },
      select: { instanceCode: true },
    });
    return new Set(rows.map((row) => row.instanceCode));
  }

  /**
   * Đơn tiền mặt Kho HN / Kho SG đã duyệt thành một dòng Đã chi / Đã thu ở Tài
   * chính nội bộ (gắn với dòng quỹ đã ghi, không ghi quỹ lần nữa); đơn bị thu
   * hồi thì hủy dòng đó.
   */
  async ensureEntry(approvalRequestId: number) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalRequestId },
    });
    if (!request?.instanceCode || !request.clientUuid.startsWith('LARK:'))
      return null;
    const mirror = await this.prisma.larkApprovalInstance.findUnique({
      where: { instanceCode: request.instanceCode },
    });
    if (!mirror) return null;
    if (mirror.approvalRequestId !== request.id)
      await this.prisma.larkApprovalInstance.update({
        where: { id: mirror.id },
        data: { approvalRequestId: request.id },
      });
    if (!mirror.inScope || !mirror.branchId || !mirror.direction) return null;
    const amount = mirror.cashAmount ?? mirror.amount;
    if (!amount) return null;
    const branchId = mirror.branchId;
    const sourceKey = `${LARK_APPROVAL_SOURCE_TYPE}:${request.instanceCode}`;

    return this.prisma.$transaction(async (tx) => {
      await this.fundLedger.lock(tx, [branchId]);
      const existing = await tx.internalFinanceEntry.findUnique({
        where: { sourceKey },
      });

      if (
        ['REVERTED', 'REJECTED', 'CANCELED', 'DELETED'].includes(request.status)
      ) {
        // PHIẾU CHI / PHIẾU CHI KHO đã hủy dòng quỹ khi thu hồi; PHIẾU THU thì chưa.
        const fundKey = fundSourceKey(request.sourceType, request.id);
        const fundRow =
          request.status === 'REVERTED' && fundKey
            ? await tx.internalFundTransaction.findUnique({
                where: { sourceKey: fundKey },
              })
            : null;
        if (fundRow?.status === 'POSTED')
          await this.fundLedger.releaseCancelled(
            tx,
            fundRow,
            request.createdById,
            LARK_REVOKED_REASON,
          );
        if (!existing || existing.status === INTERNAL_FINANCE_STATUS.CANCELLED)
          return existing;
        return tx.internalFinanceEntry.update({
          where: { id: existing.id },
          data: {
            status: INTERNAL_FINANCE_STATUS.CANCELLED,
            cancelReason: LARK_REVOKED_REASON,
            cancelledAt: new Date(),
            cancelledBy: request.createdById,
            cashIssued: false,
          },
        });
      }
      if (request.status !== 'APPROVED') return existing;

      const fundKey = fundSourceKey(request.sourceType, request.id);
      const found = fundKey
        ? await tx.internalFundTransaction.findUnique({
            where: { sourceKey: fundKey },
          })
        : null;
      // Chỉ dòng quỹ còn hiệu lực; dòng đã hủy tay coi như không có.
      const fundRow = found?.status === 'POSTED' ? found : null;
      const completedAt =
        request.completedAt || mirror.completedAt || new Date();
      // Sổ quỹ Lark đã ghi khoản này: trước ngày dùng POS, hoặc có dòng sổ trùng.
      const ledgerOnLark =
        !fundRow &&
        (completedAt.getTime() < LARK_LEDGER_CUTOFF.getTime() ||
          (await this.hasLedgerTwin(tx, {
            branchId,
            receipt: mirror.direction === 'RECEIPT',
            amount: Number(amount),
            at: mirror.occurredAt || completedAt,
          })));
      // Đơn từ mốc trở đi mà quỹ không có tiền ra / vào: không tạo dòng "Đã chi".
      if (!existing && !fundRow && !ledgerOnLark) return null;
      let entry = existing;
      if (!entry) {
        const direction = mirror.direction!;
        const isReceipt = direction === 'RECEIPT';
        const category = isReceipt
          ? INTERNAL_FINANCE_CATEGORY.CASH_FUND_RECEIPT
          : INTERNAL_FINANCE_CATEGORY.CASH_FUND_EXPENSE;
        const occurredAt = mirror.occurredAt || completedAt;
        const ledgerRecorded = ledgerOnLark;
        const code = await this.codeService.nextCode(tx, {
          direction,
          category,
          branchId,
          occurredAt,
        });
        entry = await tx.internalFinanceEntry.create({
          data: {
            code,
            direction,
            category,
            branchId,
            amount,
            occurredAt,
            sourceType: LARK_APPROVAL_SOURCE_TYPE,
            sourceId: String(request.id),
            sourceKey,
            sourceSnapshot: {
              formKind: mirror.formKind,
              approvalRequestId: request.id,
              ...(ledgerRecorded ? { larkLedgerRecorded: true } : {}),
            },
            description: mirror.description,
            evidenceStatus: INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE,
            requiresEvidence: false,
            status: INTERNAL_FINANCE_STATUS.POSTED,
            cashIssued: true,
            cashIssuedAt: completedAt,
            cashIssuedBy: request.createdById,
            cashIssuedReason: LARK_APPROVED_REASON,
            posManagedAt: new Date(),
            payerId: isReceipt ? null : mirror.requesterId,
            createdBy: request.createdById,
          },
        });
      }
      if (fundRow && !fundRow.entryId)
        await tx.internalFundTransaction.update({
          where: { id: fundRow.id },
          data: { entryId: entry.id },
        });
      if (mirror.entryId !== entry.id)
        await tx.larkApprovalInstance.update({
          where: { id: mirror.id },
          data: { entryId: entry.id },
        });
      return entry;
    });
  }

  /** Phiếu chi POS khác nguồn Lark, cùng quỹ, cùng số tiền, lệch tối đa 2 ngày. */
  private async findSuspectDuplicate(summary: LarkInstanceSummary) {
    const amount = summary.cashAmount ?? summary.amount;
    if (!summary.branchId || !amount || !summary.occurredAt) return null;
    const at = summary.occurredAt.getTime();
    const match = await this.prisma.internalFinanceEntry.findFirst({
      where: {
        branchId: summary.branchId,
        direction: 'EXPENSE',
        amount,
        status: { not: INTERNAL_FINANCE_STATUS.CANCELLED },
        sourceType: { not: LARK_APPROVAL_SOURCE_TYPE },
        occurredAt: { gte: new Date(at - 2 * DAY), lt: new Date(at + 3 * DAY) },
      },
      orderBy: { occurredAt: 'asc' },
      select: { id: true },
    });
    return match?.id ?? null;
  }
}

/** Lark báo gọi quá nhanh (mã 99991400, HTTP 400/429). */
function isRateLimited(error: unknown) {
  const err = error as {
    response?: { status?: number; data?: { code?: number } };
    message?: string;
  };
  return (
    err?.response?.data?.code === 99991400 ||
    err?.response?.status === 429 ||
    /frequency limit/i.test(err?.message || '')
  );
}

/**
 * Gọi lại API Lark khi lỗi tạm thời: 503 thì chờ ngắn, gọi quá nhanh
 * (99991400) thì chờ lâu dần tới khi Lark mở lại hạn mức.
 */
export async function retryLark<T>(
  run: () => Promise<T>,
  attempts = 8,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = isRateLimited(error) ? 5000 * attempt : 1500 * attempt;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Dòng quỹ mà đơn Lark đã ghi, theo loại đơn. */
export function fundSourceKey(sourceType: string | null, requestId: number) {
  if (sourceType === 'LARK_PAYMENT_VOUCHER')
    return `PAYMENT_VOUCHER:${requestId}`;
  if (sourceType === 'INTERNAL_FUND_RECEIPT') return `RECEIPT:${requestId}`;
  return null;
}

export function parseForm(raw: unknown): ApprovalFormItem[] {
  if (Array.isArray(raw)) return raw as ApprovalFormItem[];
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Lark trả thời gian dạng chuỗi mili giây. */
export function larkTime(value: unknown): Date | null {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}
