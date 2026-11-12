import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { Writable } from 'stream';

export const FUND_EXPORT_SELECT =
  Prisma.validator<Prisma.InternalFundTransactionSelect>()({
    id: true,
    code: true,
    transactionType: true,
    amount: true,
    occurredAt: true,
    description: true,
    sourceType: true,
    status: true,
    createdAt: true,
    cancelledAt: true,
    cancelReason: true,
    branch: { select: { name: true } },
    entry: {
      select: {
        code: true,
        occurredAt: true,
        weeklyBatch: { select: { code: true } },
      },
    },
    approvalRequest: { select: { instanceCode: true } },
    transfer: { select: { code: true } },
  });

type FundExportRow = Prisma.InternalFundTransactionGetPayload<{
  select: typeof FUND_EXPORT_SELECT;
}>;

const TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Thu nội bộ',
  EXPENSE: 'Chi',
  TRANSFER_IN: 'Chuyển đến',
  TRANSFER_OUT: 'Chuyển đi',
};
const SOURCE_LABELS: Record<string, string> = {
  WAREHOUSE_CASH_RECEIPT: 'Thu tiền khách',
  LARK_PAYMENT_VOUCHER: 'Phiếu chi theo đơn duyệt',
};
const MONEY_FORMAT = '#,##0.00;[Red](#,##0.00);"-"';
const DATE_FORMAT = 'dd/mm/yyyy hh:mm';
// Excel dates have no timezone; store Vietnam wall-clock time.
const excelDate = (value: Date | null) =>
  value ? new Date(value.getTime() + 7 * 3600000) : null;
const isExpense = (row: FundExportRow) =>
  ['EXPENSE', 'TRANSFER_OUT'].includes(row.transactionType);

const FUND_EXPORT_COLUMNS = [
  { key: 'branchName', header: 'Chi nhánh', width: 24 },
  { key: 'code', header: 'Mã giao dịch quỹ', width: 28 },
  { key: 'entryCode', header: 'Mã phiếu', width: 28 },
  { key: 'occurredAt', header: 'Ngày ghi quỹ', width: 22, numFmt: DATE_FORMAT },
  { key: 'entryDate', header: 'Ngày phiếu', width: 16, numFmt: 'dd/mm/yyyy' },
  { key: 'direction', header: 'Phân loại', width: 16 },
  { key: 'type', header: 'Loại', width: 30 },
  { key: 'description', header: 'Nội dung', width: 48 },
  { key: 'receipt', header: 'Tiền thu', width: 20, numFmt: MONEY_FORMAT },
  { key: 'expense', header: 'Tiền chi', width: 20, numFmt: MONEY_FORMAT },
  { key: 'status', header: 'Trạng thái', width: 18 },
  { key: 'amount', header: 'Số tiền', width: 20, numFmt: MONEY_FORMAT },
  { key: 'weeklyBatchCode', header: 'Approval tuần', width: 28 },
  { key: 'approvalCode', header: 'Mã đơn duyệt', width: 40 },
  { key: 'transferCode', header: 'Mã chuyển quỹ', width: 28 },
  { key: 'createdAt', header: 'Ngày tạo', width: 22, numFmt: DATE_FORMAT },
  { key: 'cancelledAt', header: 'Ngày hủy', width: 22, numFmt: DATE_FORMAT },
  { key: 'cancelReason', header: 'Lý do hủy', width: 40 },
];

export function fundExportColumns(detail: boolean, columns?: string) {
  if (!detail) return FUND_EXPORT_COLUMNS.slice(0, 11);
  if (!columns) return FUND_EXPORT_COLUMNS;
  const keys = columns
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (
    !keys.length ||
    keys.some((key) => !FUND_EXPORT_COLUMNS.some((col) => col.key === key))
  )
    throw new BadRequestException('Cột xuất chi tiết không hợp lệ');
  return FUND_EXPORT_COLUMNS.filter((col) => keys.includes(col.key));
}

export async function writeFundExport(
  stream: Writable,
  columns: ReturnType<typeof fundExportColumns>,
  detail: boolean,
  loadBatch: (skip: number, take: number) => Promise<FundExportRow[]>,
) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
  });
  const sheet = workbook.addWorksheet(
    detail ? 'Sổ quỹ chi tiết' : 'Sổ quỹ tổng quan',
    { views: [{ state: 'frozen', ySplit: 1 }] },
  );
  sheet.columns = [
    { header: 'STT', key: 'stt', width: 10 },
    ...columns.map(({ numFmt, ...column }) => ({
      ...column,
      ...(numFmt ? { style: { numFmt } } : {}),
    })),
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, size: 11 };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' },
  };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  header.commit();

  let count = 0;
  let receipt = new Prisma.Decimal(0);
  let expense = new Prisma.Decimal(0);
  const batchSize = 500;
  while (true) {
    const batch = await loadBatch(count, batchSize);
    for (const row of batch) {
      const out = isExpense(row);
      const amount = Number(row.amount);
      if (out) expense = expense.add(row.amount);
      else receipt = receipt.add(row.amount);
      const values: Record<string, ExcelJS.CellValue> = {
        stt: ++count,
        branchName: row.branch.name,
        code: row.code,
        entryCode: row.entry?.code || '',
        occurredAt: excelDate(row.occurredAt),
        entryDate: excelDate(row.entry?.occurredAt || null),
        direction: out ? 'Tiền chi' : 'Tiền thu',
        type:
          (row.sourceType !== 'LEDGER_HISTORY' &&
            SOURCE_LABELS[row.sourceType]) ||
          TYPE_LABELS[row.transactionType] ||
          row.transactionType,
        description: row.description || '',
        receipt: out ? 0 : amount,
        expense: out ? amount : 0,
        amount,
        status:
          row.status === 'POSTED'
            ? 'Đã ghi quỹ'
            : row.status === 'CANCELLED'
              ? 'Đã hủy'
              : row.status,
        weeklyBatchCode: row.entry?.weeklyBatch?.code || '',
        approvalCode: row.approvalRequest?.instanceCode || '',
        transferCode: row.transfer?.code || '',
        createdAt: excelDate(row.createdAt),
        cancelledAt: excelDate(row.cancelledAt),
        cancelReason: row.cancelReason || '',
      };
      // Only write selected columns, including when a caller requests a subset.
      const output = sheet.addRow({
        stt: values.stt,
        ...Object.fromEntries(columns.map(({ key }) => [key, values[key]])),
      });
      output.alignment = { vertical: 'top', wrapText: true };
      output.commit();
    }
    if (batch.length < batchSize) break;
  }
  sheet.autoFilter = {
    from: 'A1',
    to: { row: count + 1, column: columns.length + 1 },
  };
  const totals = sheet.addRow({
    stt: 'Tổng',
    ...(columns.some((col) => col.key === 'receipt')
      ? { receipt: receipt.toNumber() }
      : {}),
    ...(columns.some((col) => col.key === 'expense')
      ? { expense: expense.toNumber() }
      : {}),
    ...(columns.some((col) => col.key === 'amount')
      ? { amount: receipt.add(expense).toNumber() }
      : {}),
  });
  totals.font = { bold: true };
  totals.commit();
  await workbook.commit();
}
