// prisma/scripts/compare-warehouse-expenses.ts
//
// Đối chiếu tổng Phiếu chi kho trên POS với bảng "Tổng hợp phiếu chi kho HN/SG"
// trên LarkBase theo từng dòng, chia phần chênh theo nguyên nhân. Chỉ ĐỌC
// LarkBase. Mặc định chạy thử, không ghi DB.
// Xem src/internal-finance/warehouse-expense-compare.ts.
//
// Với --apply --user=<id>: hủy các phiếu xe chuyển từ Lark (trước 13/10/2026)
// không có dòng ở bảng phiếu chi Lark — Lark không tính thì POS cũng không tính.
//
// Cách chạy:
//   yarn compare:warehouse-expenses --branch=SG --from=2026-01-01 --to=2026-10-12
//   yarn compare:warehouse-expenses --branch=SG --from=... --to=... --apply --user=<id>

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaClient } from '@prisma/client';
import { fundDayStart } from '../../src/internal-fund/internal-fund-ledger.service';
import {
  EXPENSE_TABLES,
  GROUP_LABEL,
  compareExpenses,
  mapLarkExpense,
  cancelVehicleNoCopy,
  type CompareGroup,
  type PosExpenseRow,
} from '../../src/internal-finance/warehouse-expense-compare';

const WAREHOUSE_EXPENSE_CATEGORIES = [
  'DELIVERY_FEE',
  'FUEL',
  'VEHICLE_CARE',
  'OTHER_EXPENSE',
];

// Tên sheet Excel tối đa 31 ký tự, không có * ? : \\ / [ ].
const SHEET_NAME: Record<CompareGroup, string> = {
  matched: 'Khớp',
  vehicleCopySkipped: 'Phiếu xe khớp dòng Lark',
  vehicleCopyMerged: 'Phiếu xe đã gộp bản sao',
  posVehicleNoCopy: 'POS - phiếu xe không có ở Lark',
  amountDiff: 'Lệch số tiền',
  larkNotImported: 'Lark - chưa nhập vào POS',
  larkOtherDepartment: 'Lark - phòng ban khác',
  larkCancelledOnPos: 'Lark - đã hủy trên POS',
  dateShift: 'Lệch ngày',
  posVehicleTable: 'POS - phiếu xe bảng xe Lark',
  posPackingSlip: 'POS - báo đơn',
  posCreated: 'POS - tạo trên POS',
  posDeletedOnLark: 'POS - dòng Lark đã xóa',
  posOtherLark: 'POS - bảng Lark khác',
};

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ||
  fallback;
const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

/** Lỗi mạng / SSL thoáng qua khi gọi Lark: thử lại vài lần trước khi dừng. */
async function withRetry<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error: any) {
      const code = error?.code || error?.cause?.code;
      const transient =
        [
          'EPROTO',
          'ECONNRESET',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EAI_AGAIN',
        ].includes(code) ||
        /tenant_access_token|socket hang up/i.test(String(error?.message));
      if (!transient || attempt >= attempts) throw error;
      console.warn(
        `⚠️ Lỗi kết nối Lark (${code || error?.message}), thử lại lần ${attempt + 1}…`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function readLarkTable(tableId: string) {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  const baseToken = process.env.LARK_EXPENSE_BASE_TOKEN;
  if (!appId || !appSecret || !baseToken)
    throw new Error(
      'Thiếu LARK_APP_ID / LARK_APP_SECRET / LARK_EXPENSE_BASE_TOKEN',
    );
  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
  });
  const records: Array<{ recordId: string; fields: Record<string, unknown> }> =
    [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(() =>
      client.bitable.appTableRecord.list({
        path: { app_token: baseToken, table_id: tableId },
        params: {
          page_size: 500,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    if (res.code && res.code !== 0)
      throw new Error(`LarkBase trả lỗi ${res.code}: ${res.msg ?? ''}`);
    for (const item of res.data?.items ?? [])
      if (item.record_id)
        records.push({
          recordId: item.record_id,
          fields: (item.fields ?? {}) as Record<string, unknown>,
        });
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return { baseToken, records };
}

async function main() {
  const branchKey = arg('branch', 'SG').toUpperCase() as 'SG' | 'HN';
  const table = EXPENSE_TABLES[branchKey];
  if (!table) throw new Error('--branch phải là SG hoặc HN');
  const from = arg('from', '2026-01-01');
  const to = arg('to', '2026-10-12');
  const apply = process.argv.includes('--apply');
  const userId = Number(arg('user', ''));
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

  const { baseToken, records } = await readLarkTable(table.tableId);
  const larkRows = records.map(mapLarkExpense);

  const prisma = new PrismaClient();
  try {
    const select = {
      id: true,
      code: true,
      occurredAt: true,
      amount: true,
      status: true,
      sourceType: true,
      sourceKey: true,
      category: true,
      description: true,
      note: true,
      cancelReason: true,
    } as const;
    const toRow = (row: any): PosExpenseRow => ({
      ...row,
      amount: Number(row.amount),
    });
    // Đúng điều kiện của trang Phiếu chi kho (không tính phiếu hủy).
    const posInRange = (
      await prisma.internalFinanceEntry.findMany({
        where: {
          direction: 'EXPENSE',
          branchId: table.branchId,
          category: { in: WAREHOUSE_EXPENSE_CATEGORIES },
          status: { not: 'CANCELLED' },
          occurredAt: {
            gte: fundDayStart(from),
            lt: new Date(fundDayStart(to).getTime() + 86_400_000),
          },
        },
        select,
      })
    ).map(toRow);
    const prefix = `LARK:${baseToken}:${table.tableId}:`;
    const posByRecord = new Map(
      (
        await prisma.internalFinanceEntry.findMany({
          where: { sourceKey: { startsWith: prefix }, direction: 'EXPENSE' },
          select,
        })
      ).map((row) => [row.sourceKey!.slice(prefix.length), toRow(row)]),
    );

    const result = compareExpenses({
      tableId: table.tableId,
      department: table.department,
      from,
      to,
      larkRows,
      posInRange,
      posByRecord,
    });

    const diff = result.posTotal - result.larkTotal;
    const summary = [
      `Đối chiếu ${table.department} từ ${from} đến ${to} (chỉ đọc)`,
      `Lark – toàn bảng: ${money(result.larkTotal)}đ (riêng ${table.department}: ${money(result.larkDepartment)}đ)`,
      `POS – trang Phiếu chi kho: ${money(result.posTotal)}đ`,
      `Chênh (POS − Lark): ${money(diff)}đ, gồm:`,
      ...(Object.keys(GROUP_LABEL) as CompareGroup[])
        .filter((group) => result.byGroup.get(group))
        .map((group) => {
          const item = result.byGroup.get(group)!;
          return `  ${GROUP_LABEL[group]}: ${item.count} dòng, ${money(item.delta)}đ`;
        }),
    ];
    console.log(summary.join('\n'));
    const noCopy = result.lines
      .filter((line) => line.group === 'posVehicleNoCopy' && line.pos)
      .map((line) => line.pos!);
    if (apply) {
      const done = await cancelVehicleNoCopy(
        prisma,
        noCopy.map((row) => row.id),
        userId,
      );
      summary.push(
        '',
        `✅ ĐÃ HỦY ${done.cancelled.length} phiếu xe không có trên bảng phiếu chi Lark.`,
        ...done.skipped.map((s) => `  Bỏ qua ${s.code}: ${s.reason}`),
      );
      console.log(summary.slice(-1 - done.skipped.length).join('\n'));
    } else if (noCopy.length)
      console.log(
        `\n🔎 Chạy thử: ${noCopy.length} phiếu xe sẽ bị hủy khi chạy --apply --user=<id> (${money(noCopy.reduce((s, r) => s + r.amount, 0))}đ).`,
      );

    const workbook = new ExcelJS.Workbook();
    const summarySheet = workbook.addWorksheet('Tóm tắt');
    summarySheet.columns = [{ header: 'Tóm tắt', key: 'line', width: 110 }];
    summary.forEach((line) => summarySheet.addRow({ line }));
    for (const group of Object.keys(GROUP_LABEL) as CompareGroup[]) {
      const lines = result.lines.filter((line) => line.group === group);
      if (!lines.length || group === 'matched') continue;
      const ws = workbook.addWorksheet(SHEET_NAME[group], {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      ws.columns = [
        { header: 'Ngày Lark', key: 'larkDay', width: 12 },
        { header: 'Tiền Lark', key: 'larkAmount', width: 14 },
        { header: 'Phòng ban', key: 'department', width: 18 },
        { header: 'Nội dung Lark', key: 'larkText', width: 50 },
        { header: 'Mã POS', key: 'code', width: 30 },
        { header: 'Ngày POS', key: 'posDay', width: 12 },
        { header: 'Tiền POS', key: 'posAmount', width: 14 },
        { header: 'Nguồn POS', key: 'source', width: 24 },
        { header: 'Nội dung POS', key: 'posText', width: 50 },
        { header: 'Lý do hủy', key: 'cancelReason', width: 40 },
        { header: 'Chênh (POS − Lark)', key: 'delta', width: 16 },
      ];
      ws.getRow(1).font = { bold: true };
      for (const line of lines)
        ws.addRow({
          larkDay: line.lark?.day || '',
          larkAmount: line.lark?.amount ?? '',
          department: line.lark?.department || '',
          larkText: [line.lark?.content, line.lark?.note]
            .filter(Boolean)
            .join(' | '),
          code: line.pos?.code || '',
          posDay: line.pos
            ? new Date(line.pos.occurredAt.getTime() + 7 * 3_600_000)
                .toISOString()
                .slice(0, 10)
            : '',
          posAmount: line.pos?.amount ?? '',
          source: line.pos
            ? `${line.pos.sourceType} / ${line.pos.category}`
            : '',
          posText: [line.pos?.description, line.pos?.note]
            .filter(Boolean)
            .join(' | '),
          cancelReason: line.pos?.cancelReason || '',
          delta: line.delta,
        });
      for (const key of ['larkAmount', 'posAmount', 'delta'])
        ws.getColumn(key).numFmt = '#,##0';
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 11 },
      };
    }
    const dir = path.resolve(__dirname, '../../reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date()
      .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
      .replace(/[: ]/g, '-');
    const file = path.join(
      dir,
      `compare-warehouse-expenses-${branchKey}-${stamp}.xlsx`,
    );
    await workbook.xlsx.writeFile(file);
    console.log(`\n📄 Chi tiết: ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌', error);
  process.exit(1);
});
