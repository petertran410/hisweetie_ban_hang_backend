import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';

const LARK_CASHFLOW_TABLE_ID = 'tblltz1Zcxe479UG';

const LARK_BRANCH_TO_POS: Record<string, number | null> = {
  'Kho Hà Nội': 6,
  'Kho Sài Gòn': 1,
  'Văn Phòng Hà Nội': 4,
  'Văn Phòng Sài Gòn': 7,
};

@Injectable()
export class CashFlowHistoryAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(LARK_CLIENT) private readonly larkClient: lark.Client,
  ) {}

  async preview(pageToken?: string, pageSize = 50) {
    const baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN');
    if (!baseToken) {
      throw new BadRequestException(
        'LARK_EXPENSE_BASE_TOKEN chưa được cấu hình',
      );
    }

    const response = await this.larkClient.bitable.appTableRecord.search({
      path: {
        app_token: baseToken,
        table_id: LARK_CASHFLOW_TABLE_ID,
      },
      params: {
        page_size: Math.min(Math.max(pageSize, 1), 100),
        page_token: pageToken,
        user_id_type: 'open_id',
      },
      data: {
        field_names: [
          'Mã Phiếu',
          'Chi Nhánh',
          'Ngày Giao Dịch',
          'Thu',
          'Chi',
          'Dòng Tiền',
          'Nội Dung',
          'Loại Thu Chi',
          'Trạng Thái',
        ],
      },
    });

    if (response?.code && response.code !== 0) {
      throw new BadRequestException(
        response.msg || 'Không đọc được lịch sử sổ quỹ Lark',
      );
    }

    const rows = await Promise.all(
      (response?.data?.items || []).map((item: any) =>
        this.normalizeRow(item),
      ),
    );

    return {
      data: rows,
      nextPageToken: response?.data?.page_token || null,
      hasMore: !!response?.data?.has_more,
    };
  }

  async importSelected(recordIds: string[], userId: number, confirm: boolean) {
    if (!confirm) {
      throw new BadRequestException(
        'Import lịch sử phải truyền confirm=true sau khi đã đối chiếu preview',
      );
    }

    const baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN');
    if (!baseToken) {
      throw new BadRequestException(
        'LARK_EXPENSE_BASE_TOKEN chưa được cấu hình',
      );
    }

    const response = await this.larkClient.bitable.appTableRecord.batchGet({
      path: {
        app_token: baseToken,
        table_id: LARK_CASHFLOW_TABLE_ID,
      },
      data: {
        record_ids: [...new Set(recordIds)],
        user_id_type: 'open_id',
      },
    });
    if (response?.code && response.code !== 0) {
      throw new BadRequestException(
        response.msg || 'Không đọc được record lịch sử Lark',
      );
    }

    const result = {
      created: [] as Array<{ recordId: string; cashFlowId: number; code: string }>,
      skipped: [] as Array<{ recordId: string; reason: string }>,
    };

    for (const item of response?.data?.records || []) {
      const recordId = item.record_id;
      if (!recordId) continue;
      const row = await this.normalizeRow(item);
      const code = `LARK-${recordId}`;

      if (row.canceled) {
        result.skipped.push({ recordId, reason: 'CANCELED' });
        continue;
      }
      if (!row.branchId) {
        result.skipped.push({ recordId, reason: 'UNKNOWN_BRANCH' });
        continue;
      }
      if (!row.transDate || row.amount <= 0) {
        result.skipped.push({ recordId, reason: 'INVALID_AMOUNT_OR_DATE' });
        continue;
      }
      if (row.candidates.length > 0) {
        result.skipped.push({ recordId, reason: 'POSSIBLE_DUPLICATE' });
        continue;
      }

      const existing = await this.prisma.cashFlow.findUnique({
        where: { code },
        select: { id: true },
      });
      if (existing) {
        result.skipped.push({ recordId, reason: 'ALREADY_IMPORTED' });
        continue;
      }

      const cashFlow = await this.prisma.cashFlow.create({
        data: {
          code,
          branchId: row.branchId,
          isReceipt: row.isReceipt,
          amount: row.amount,
          transDate: row.transDate,
          method: 'cash',
          usedForFinancialReporting: 1,
          description: `[LARK:${recordId}] ${row.description || row.type || 'Lark history'}`,
          status: 0,
          statusValue: row.isReceipt ? 'Đã thanh toán' : 'Đã chi',
          createdBy: userId,
          collectorUserId: userId,
        },
        select: { id: true, code: true },
      });
      result.created.push({
        recordId,
        cashFlowId: cashFlow.id,
        code: cashFlow.code,
      });
    }

    return result;
  }

  private async normalizeRow(item: any) {
    const fields = item?.fields || {};
    const branchName = this.text(fields['Chi Nhánh']);
    const branchId = LARK_BRANCH_TO_POS[branchName] ?? null;
    const receipt = this.number(fields.Thu);
    const payment = this.number(fields.Chi);
    const amount = receipt > 0 ? receipt : payment;
    const isReceipt = receipt > 0;
    const transDate = this.parseDate(fields['Ngày Giao Dịch']);
    const canceled = this.text(fields['Trạng Thái']) === 'Hủy';

    const candidates =
      branchId && amount > 0 && transDate
        ? await this.findCandidates(branchId, isReceipt, amount, transDate)
        : [];

    return {
      sourceRecordId: item?.record_id || null,
      code: this.text(fields['Mã Phiếu']) || null,
      branchName,
      branchId,
      isReceipt,
      amount,
      transDate,
      description: this.text(fields['Nội Dung']) || null,
      type: this.text(fields['Loại Thu Chi']) || null,
      canceled,
      candidates,
    };
  }

  private async findCandidates(
    branchId: number,
    isReceipt: boolean,
    amount: number,
    transDate: Date,
  ) {
    const from = new Date(transDate);
    from.setDate(from.getDate() - 1);
    const to = new Date(transDate);
    to.setDate(to.getDate() + 1);

    return this.prisma.cashFlow.findMany({
      where: {
        branchId,
        isReceipt,
        amount,
        status: 0,
        transDate: { gte: from, lte: to },
      },
      select: {
        id: true,
        code: true,
        amount: true,
        transDate: true,
        description: true,
      },
      take: 5,
      orderBy: { transDate: 'asc' },
    });
  }

  private text(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value
        .map((part) =>
          typeof part === 'string' || typeof part === 'number'
            ? String(part)
            : part && typeof part === 'object' && 'text' in part
              ? String((part as any).text || '')
              : '',
        )
        .join('');
    }
    if (typeof value === 'object' && 'text' in value) {
      return String((value as any).text || '');
    }
    return '';
  }

  private number(value: unknown): number {
    const parsed = Number(this.text(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  }

  private parseDate(value: unknown): Date | null {
    if (typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const text = this.text(value);
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
