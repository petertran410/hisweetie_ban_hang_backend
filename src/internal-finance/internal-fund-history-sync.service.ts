import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from '../internal-fund/internal-fund-ledger.service';
import {
  LarkFinanceImportClient,
  type LarkImportRecord,
} from './lark-finance-import.client';
import {
  branchFromLabel,
  readLarkDate,
  readLarkNumber,
  readLarkText,
} from './internal-finance-lark-import.mapper';

// Bảng "Giao Dịch Tiền Mặt - Kho": sổ quỹ tiền mặt đang dùng trên Lark Base.
const LEDGER_TABLE_FALLBACK = 'tblltz1Zcxe479UG';
const TRANSFER_CATEGORY = 'chuyển tiền nội bộ';

export interface FundHistorySyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
}

interface LedgerRow {
  sourceKey: string;
  code: string;
  branchId: number;
  transactionType: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  description: string;
  status: 'POSTED' | 'CANCELLED';
  linkedExpenseIds: string[];
  createdAt: Date | null;
  modifiedAt: Date | null;
}

/**
 * Đồng bộ toàn bộ bút toán sổ quỹ tiền mặt lịch sử vào quỹ nội bộ để POS tính
 * được đầu kỳ / trong kỳ / cuối kỳ. Chạy lại nhiều lần an toàn: mỗi bút toán
 * có khóa cố định, dòng đổi trên nguồn thì cập nhật, không tạo trùng.
 */
@Injectable()
export class InternalFundHistorySyncService {
  private readonly logger = new Logger(InternalFundHistorySyncService.name);
  private current: Promise<void> | null = null;
  private status: FundHistorySyncStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    error: null,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lark: LarkFinanceImportClient,
    private readonly fundLedger: InternalFundLedgerService,
  ) {}

  getStatus(): FundHistorySyncStatus {
    return { ...this.status };
  }

  start(userId: number): FundHistorySyncStatus {
    if (this.status.running)
      throw new BadRequestException('Đang đồng bộ sổ quỹ, vui lòng chờ');
    const baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN');
    if (!baseToken)
      throw new BadRequestException('Chưa cấu hình nguồn dữ liệu sổ quỹ');
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      error: null,
    };
    this.current = this.run(baseToken, userId)
      .catch((error: any) => {
        this.status.error = error?.message || 'Đồng bộ sổ quỹ thất bại';
        this.logger.error(`[FUND_HISTORY] ${this.status.error}`);
      })
      .finally(() => {
        this.status.running = false;
        this.status.finishedAt = new Date().toISOString();
      });
    return this.getStatus();
  }

  /** Chạy đồng bộ và chờ xong; dùng cho luồng đồng bộ gộp. */
  async runAndWait(userId: number): Promise<FundHistorySyncStatus> {
    this.start(userId);
    await this.current;
    return this.getStatus();
  }

  private async run(baseToken: string, userId: number) {
    const tableId =
      this.config.get<string>('LARK_FUND_LEDGER_TABLE') ||
      LEDGER_TABLE_FALLBACK;
    const expenseTables = [
      this.config.get<string>('LARK_EXPENSE_TABLE_HN'),
      this.config.get<string>('LARK_EXPENSE_TABLE_SG'),
    ].filter((value): value is string => Boolean(value));
    const token = await this.lark.getToken();
    const earliest = new Map<number, Date>();

    await this.lark.forEachRecordPage(
      baseToken,
      tableId,
      token,
      async (records) => {
        this.status.fetched += records.length;
        const rows = records
          .map((record) => this.mapRecord(record))
          .filter((row): row is LedgerRow => row !== null);
        this.status.skipped += records.length - rows.length;
        const fresh = await this.dropAlreadyIssued(
          rows,
          baseToken,
          expenseTables,
        );
        this.status.skipped += rows.length - fresh.length;
        await this.persist(fresh, userId, earliest);
      },
    );

    await this.prisma.$transaction(async (tx) => {
      for (const [branchId, date] of earliest)
        await this.fundLedger.invalidateClosings(tx, branchId, date);
    });
    this.logger.log(
      `[FUND_HISTORY] fetched=${this.status.fetched} created=${this.status.created} updated=${this.status.updated} skipped=${this.status.skipped}`,
    );
  }

  private mapRecord(record: LarkImportRecord): LedgerRow | null {
    const fields = record.fields;
    // Quỹ không có trên POS (vd. cửa hàng) trả về null và bị bỏ qua.
    const branchId = branchFromLabel(readLarkText(fields['Chi Nhánh']));
    if (!branchId) return null;
    const receipt = readLarkNumber(fields['Thu']) || 0;
    const expense = readLarkNumber(fields['Chi']) || 0;
    const incoming = receipt > 0;
    const amount = incoming ? receipt : expense;
    if (!(amount > 0)) return null;
    const occurredAt =
      readLarkDate(fields['Ngày Giao Dịch']) ||
      readLarkDate(fields['Ngày Tạo']);
    if (!occurredAt) return null;
    const category = readLarkText(fields['Loại Thu Chi']);
    const transfer = category.toLowerCase() === TRANSFER_CATEGORY;
    const serial = readLarkText(fields['STT']);
    return {
      sourceKey: `LARK_LEDGER:${record.recordId}`,
      code: serial ? `SQ-${serial}` : this.fundLedger.code('SQ'),
      branchId,
      transactionType: transfer
        ? incoming
          ? 'TRANSFER_IN'
          : 'TRANSFER_OUT'
        : incoming
          ? 'RECEIPT'
          : 'EXPENSE',
      amount: new Prisma.Decimal(amount),
      occurredAt,
      description: readLarkText(fields['Nội Dung']) || category,
      status:
        readLarkText(fields['Trạng Thái']).toLowerCase() === 'hủy'
          ? 'CANCELLED'
          : 'POSTED',
      linkedExpenseIds: [
        ...this.recordIds(fields['Phiếu Chi HN']),
        ...this.recordIds(fields['Phiếu Chi SG']),
      ],
      createdAt: record.createdAt ?? null,
      modifiedAt: record.modifiedAt ?? record.createdAt ?? null,
    };
  }

  private recordIds(value: unknown): string[] {
    const found = new Set<string>();
    const walk = (item: unknown) => {
      if (typeof item === 'string') {
        if (/^rec[A-Za-z0-9]{6,}$/.test(item)) found.add(item);
      } else if (Array.isArray(item)) item.forEach(walk);
      else if (item && typeof item === 'object')
        Object.values(item as Record<string, unknown>).forEach(walk);
    };
    walk(value);
    return [...found];
  }

  // Khoản chi kho đã được ghi quỹ khi nhập phiếu chi thì không ghi lần hai.
  private async dropAlreadyIssued(
    rows: LedgerRow[],
    baseToken: string,
    expenseTables: string[],
  ) {
    const keys = rows.flatMap((row) =>
      row.linkedExpenseIds.flatMap((id) =>
        expenseTables.map((table) => `LARK:${baseToken}:${table}:${id}`),
      ),
    );
    if (!keys.length) return rows;
    const issued = await this.prisma.internalFinanceEntry.findMany({
      where: {
        sourceKey: { in: keys },
        fundTransaction: { status: 'POSTED' },
      },
      select: { sourceKey: true },
    });
    const issuedIds = new Set(
      issued.map((entry) => String(entry.sourceKey).split(':').pop()),
    );
    return rows.filter(
      (row) => !row.linkedExpenseIds.some((id) => issuedIds.has(id)),
    );
  }

  private async persist(
    rows: LedgerRow[],
    userId: number,
    earliest: Map<number, Date>,
  ) {
    if (!rows.length) return;
    const existing = await this.prisma.internalFundTransaction.findMany({
      where: { sourceKey: { in: rows.map((row) => row.sourceKey) } },
      select: {
        id: true,
        sourceKey: true,
        branchId: true,
        transactionType: true,
        amount: true,
        occurredAt: true,
        description: true,
        status: true,
      },
    });
    const bySource = new Map(existing.map((row) => [row.sourceKey, row]));
    const touch = (branchId: number, date: Date) => {
      const current = earliest.get(branchId);
      if (!current || date < current) earliest.set(branchId, date);
    };
    const creates: Prisma.InternalFundTransactionCreateManyInput[] = [];
    const updates: Array<{ id: number; row: LedgerRow }> = [];
    for (const row of rows) {
      const current = bySource.get(row.sourceKey);
      if (!current) {
        creates.push({
          code: row.code,
          sourceKey: row.sourceKey,
          branchId: row.branchId,
          transactionType: row.transactionType,
          amount: row.amount,
          occurredAt: row.occurredAt,
          description: row.description,
          sourceType: FUND_SOURCE_TYPE.LEDGER_HISTORY,
          status: row.status,
          cancelledAt: row.status === 'CANCELLED' ? new Date() : null,
          createdBy: userId,
          ...(row.createdAt ? { createdAt: row.createdAt } : {}),
          ...(row.modifiedAt ? { updatedAt: row.modifiedAt } : {}),
        });
        touch(row.branchId, row.occurredAt);
        continue;
      }
      const changed =
        current.branchId !== row.branchId ||
        current.transactionType !== row.transactionType ||
        !current.amount.equals(row.amount) ||
        current.occurredAt.getTime() !== row.occurredAt.getTime() ||
        (current.description || '') !== row.description ||
        current.status !== row.status;
      if (!changed) continue;
      updates.push({ id: current.id, row });
      touch(row.branchId, row.occurredAt);
      touch(current.branchId, current.occurredAt);
    }
    if (!creates.length && !updates.length) return;
    await this.prisma.$transaction(
      async (tx) => {
        await this.fundLedger.lock(tx, [
          ...creates.map((row) => row.branchId),
          ...updates.map((item) => item.row.branchId),
        ]);
        if (creates.length) {
          const result = await tx.internalFundTransaction.createMany({
            data: creates,
            skipDuplicates: true,
          });
          this.status.created += result.count;
        }
        for (const { id, row } of updates) {
          await tx.internalFundTransaction.update({
            where: { id },
            data: {
              branchId: row.branchId,
              transactionType: row.transactionType,
              amount: row.amount,
              occurredAt: row.occurredAt,
              description: row.description,
              status: row.status,
              cancelledAt: row.status === 'CANCELLED' ? new Date() : null,
              ...(row.modifiedAt ? { updatedAt: row.modifiedAt } : {}),
            },
          });
          this.status.updated += 1;
        }
      },
      { timeout: 60000 },
    );
  }
}
