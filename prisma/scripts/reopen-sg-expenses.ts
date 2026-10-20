// prisma/scripts/reopen-sg-expenses.ts
//
// Kho SG: mở lại phiếu chi đồng bộ từ LarkBase đang bị tick sẵn Quản lý kho /
// Kế toán kho và "Đã chi" dù tuần chưa duyệt. Xem
// src/internal-finance/sg-expense-reopen.ts. Phiếu thuộc Approval tuần đã gửi
// hoặc đã duyệt giữ nguyên. Chạy thử chỉ đọc DB.
// Chi tiết: reports/reopen-sg-expenses-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn reopen:sg-expenses                          # chạy thử, không ghi
//   yarn reopen:sg-expenses --from=2026-10-12        # đổi ngày bắt đầu
//   yarn reopen:sg-expenses --from=2026-09-28 --to=2026-10-11  # một khoảng ngày
//   yarn reopen:sg-expenses --apply --user=<id>      # ghi thật

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import {
  REOPEN_FROM,
  applySgReopen,
  loadSgReopen,
  sgFundBalance,
  type ReopenItem,
} from '../../src/internal-finance/sg-expense-reopen';

const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

function action(item: ReopenItem) {
  const parts = ['Bỏ tick QLK/KTK', 'bỏ Đã chi'];
  if (item.entry.weeklyBatchId) parts.push('gỡ khỏi batch chưa gửi');
  if (item.fundRows.length)
    parts.push(`hủy ${item.fundRows.length} dòng quỹ POS`);
  if (item.markLedger)
    parts.push('gắn dấu "đã trừ trên sổ quỹ Lark" (duyệt sau không trừ lần 2)');
  return parts.join(', ');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const arg = (name: string) =>
    process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1];
  const userId = Number(arg('user'));
  const from = arg('from') || REOPEN_FROM;
  const to = arg('to');
  for (const value of [from, to].filter(Boolean) as string[])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error('--from / --to phải có dạng YYYY-MM-DD');
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

  const prisma = new PrismaClient();
  try {
    const before = await sgFundBalance(prisma);
    const plan = apply
      ? await applySgReopen(prisma, userId, from, to)
      : await loadSgReopen(prisma, from, to);
    const after = apply ? await sgFundBalance(prisma) : null;

    const items = plan.items;
    const fundRows = items.flatMap((item) => item.fundRows);
    const fundTotal = fundRows.reduce(
      (sum, row) => sum + Number(row.amount),
      0,
    );
    console.log(apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)');
    console.log(
      `Phiếu SG đồng bộ từ Lark từ ${from.split('-').reverse().join('/')}${to ? ` đến ${to.split('-').reverse().join('/')}` : ''}: ${items.length} phiếu (${money(
        items.reduce((sum, item) => sum + Number(item.entry.amount), 0),
      )})`,
    );
    console.log(
      `  - Đang tick QLK/KTK: ${items.filter((item) => item.entry.managerReviewedAt || item.entry.accountantReviewedAt).length}`,
    );
    console.log(
      `  - Đang "Đã chi": ${items.filter((item) => item.entry.cashIssued).length}`,
    );
    console.log(
      `  - Trong batch chưa gửi: ${items.filter((item) => item.entry.weeklyBatchId).length}`,
    );
    console.log(
      `  - Dòng quỹ POS sẽ hủy: ${fundRows.length} (${money(fundTotal)})`,
    );
    console.log(
      `  - Gắn dấu đã trừ trên sổ quỹ Lark: ${items.filter((item) => item.markLedger).length}`,
    );
    console.log(
      `Quỹ Kho SG: ${money(before)} → ${money(after ?? before + fundTotal)}${after === null ? ' (dự kiến)' : ''}`,
    );

    const file = await writeWorkbook(items);
    console.log(`📄 Chi tiết: ${file}`);
    if (!apply)
      console.log('👉 Xem file, đồng ý thì chạy lại với --apply --user=<id>.');
  } finally {
    await prisma.$disconnect();
  }
}

async function writeWorkbook(items: ReopenItem[]) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `reopen-sg-expenses-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Phieu SG mo lai', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = [
    { header: 'Mã phiếu', key: 'code', width: 30 },
    { header: 'Ngày', key: 'date', width: 12 },
    { header: 'Nội dung', key: 'description', width: 60 },
    { header: 'Số tiền', key: 'amount', width: 14 },
    { header: 'Tick QLK', key: 'manager', width: 10 },
    { header: 'Tick KTK', key: 'accountant', width: 10 },
    { header: 'Đã chi', key: 'issued', width: 10 },
    { header: 'Lý do đã chi', key: 'reason', width: 32 },
    { header: 'Batch', key: 'batch', width: 34 },
    { header: 'Dòng quỹ POS', key: 'fund', width: 30 },
    { header: 'Sẽ làm', key: 'action', width: 70 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const item of items) {
    const entry = item.entry;
    ws.addRow({
      code: entry.code,
      date: vnDate(entry.occurredAt),
      description: entry.description,
      amount: Number(entry.amount),
      manager: entry.managerReviewedAt ? 'x' : '',
      accountant: entry.accountantReviewedAt ? 'x' : '',
      issued: entry.cashIssued ? 'x' : '',
      reason: entry.cashIssuedReason || '',
      batch: entry.weeklyBatch
        ? `${entry.weeklyBatch.code} (${entry.weeklyBatch.status})`
        : '',
      fund: item.fundRows
        .map((row) => `${row.code} ${money(row.amount)}`)
        .join(', '),
      action: action(item),
    });
  }
  ws.getColumn('amount').numFmt = '#,##0';
  if (items.length)
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };
  await workbook.xlsx.writeFile(file);
  return file;
}

main().catch((error) => {
  console.error('❌ Lỗi:', error?.message || error);
  process.exit(1);
});
