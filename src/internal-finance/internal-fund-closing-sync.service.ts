import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fundClosingDate } from '../internal-fund/internal-fund-ledger.service';
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

// Bảng "Chốt Sổ Kho Hàng Ngày" trên Lark Base.
const CLOSING_TABLE_FALLBACK = 'tblOHd3bOOqXbh3t';

export interface ClosingSyncCounts {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface ClosingRow {
  sourceKey: string;
  branchId: number;
  closingDate: Date;
  actualOpeningBalance: Prisma.Decimal | null;
  actualReceipt: Prisma.Decimal | null;
  actualExpense: Prisma.Decimal | null;
  actualClosingBalance: Prisma.Decimal | null;
  systemOpeningBalance: Prisma.Decimal;
  systemReceipt: Prisma.Decimal;
  systemExpense: Prisma.Decimal;
  systemClosingBalance: Prisma.Decimal;
  notes: string | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
}

const decimal = (value: number | null) =>
  value === null ? null : new Prisma.Decimal(value);

/** Đổi một dòng chốt sổ trên Lark thành dòng chốt sổ POS; null nếu không dùng được. */
export function mapClosingRecord(record: LarkImportRecord): ClosingRow | null {
  const fields = record.fields;
  // Quỹ không có trên POS (vd. cửa hàng) bị bỏ qua.
  const branchId = branchFromLabel(readLarkText(fields['Chi Nhánh']));
  const date = readLarkDate(fields['Ngày']);
  if (!branchId || !date) return null;
  const opening = readLarkNumber(fields['Đầu Kì']);
  const receipt = readLarkNumber(fields['Thu']);
  const expense = readLarkNumber(fields['Chi']);
  const entered = [opening, receipt, expense].some((value) => value !== null);
  const modifiedAt = record.modifiedAt ?? record.createdAt ?? null;
  const systemOpening = readLarkNumber(fields['Đầu Kì Lark']) ?? 0;
  const systemReceipt = readLarkNumber(fields['Thu Lark']) ?? 0;
  const systemExpense = readLarkNumber(fields['Chi Lark']) ?? 0;
  return {
    sourceKey: `LARK_CLOSING:${record.recordId}`,
    branchId,
    closingDate: fundClosingDate(date),
    actualOpeningBalance: decimal(opening),
    actualReceipt: decimal(receipt),
    actualExpense: decimal(expense),
    // Cùng công thức với cột "Cuối Kì": ô trống tính là 0.
    actualClosingBalance: entered
      ? new Prisma.Decimal(opening ?? 0).plus(receipt ?? 0).minus(expense ?? 0)
      : null,
    systemOpeningBalance: new Prisma.Decimal(systemOpening),
    systemReceipt: new Prisma.Decimal(systemReceipt),
    systemExpense: new Prisma.Decimal(systemExpense),
    systemClosingBalance: new Prisma.Decimal(systemOpening)
      .plus(systemReceipt)
      .minus(systemExpense),
    notes: readLarkText(fields['Ghi Chú']) || null,
    createdAt: record.createdAt ?? null,
    modifiedAt,
  };
}

/**
 * Đồng bộ lịch sử chốt sổ quỹ hàng ngày (số kế toán nhập và ghi chú)
 * vào POS. Chạy lại nhiều lần an toàn; dòng đã sửa trên POS thì giữ nguyên.
 */
@Injectable()
export class InternalFundClosingSyncService {
  private readonly logger = new Logger(InternalFundClosingSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lark: LarkFinanceImportClient,
  ) {}

  async run(userId: number): Promise<ClosingSyncCounts> {
    const baseToken = this.config.get<string>('LARK_EXPENSE_BASE_TOKEN');
    if (!baseToken)
      throw new BadRequestException('Chưa cấu hình nguồn dữ liệu chốt sổ');
    const tableId =
      this.config.get<string>('LARK_FUND_CLOSING_TABLE') ||
      CLOSING_TABLE_FALLBACK;
    const token = await this.lark.getToken();
    const counts: ClosingSyncCounts = {
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
    };
    // Một ngày của một quỹ chỉ giữ dòng sửa gần nhất.
    const latest = new Map<string, ClosingRow>();
    await this.lark.forEachRecordPage(
      baseToken,
      tableId,
      token,
      async (records) => {
        counts.fetched += records.length;
        for (const record of records) {
          const row = mapClosingRecord(record);
          if (!row) {
            counts.skipped += 1;
            continue;
          }
          const key = `${row.branchId}:${row.closingDate.toISOString()}`;
          const current = latest.get(key);
          if (current) counts.skipped += 1;
          if (
            !current ||
            (row.modifiedAt?.getTime() ?? 0) >=
              (current.modifiedAt?.getTime() ?? 0)
          )
            latest.set(key, row);
        }
      },
    );
    for (const row of latest.values()) await this.persist(row, userId, counts);
    this.logger.log(
      `[FUND_CLOSING] fetched=${counts.fetched} created=${counts.created} updated=${counts.updated} skipped=${counts.skipped}`,
    );
    return counts;
  }

  private async persist(
    row: ClosingRow,
    userId: number,
    counts: ClosingSyncCounts,
  ) {
    const { createdAt, modifiedAt, branchId, closingDate, ...values } = row;
    const where = { branchId_closingDate: { branchId, closingDate } };
    const existing = await this.prisma.internalFundDailyClosing.findUnique({
      where,
      select: { id: true, posManagedAt: true, sourceKey: true },
    });
    if (existing?.posManagedAt) {
      counts.skipped += 1;
      return;
    }
    const data = {
      ...values,
      reconciliationStatus: !values.actualClosingBalance
        ? 'PENDING'
        : values.actualClosingBalance.equals(values.systemClosingBalance)
          ? 'MATCHED'
          : 'MISMATCHED',
      ...(modifiedAt ? { updatedAt: modifiedAt } : {}),
    };
    if (existing) {
      await this.prisma.internalFundDailyClosing.update({ where, data });
      counts.updated += 1;
      return;
    }
    await this.prisma.internalFundDailyClosing.create({
      data: {
        ...data,
        branchId,
        closingDate,
        createdBy: userId,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    counts.created += 1;
  }
}
