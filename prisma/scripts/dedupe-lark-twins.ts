// prisma/scripts/dedupe-lark-twins.ts
//
// Gộp một lần các phiếu chi bị nhập đôi từ LarkBase: bản sao ở bảng "Tổng hợp
// phiếu chi kho" của phiếu xe (Xăng dầu / Chăm sóc xe) và của cước báo đơn.
// Xem src/internal-finance/lark-twin-dedupe.ts. Chỉ đọc DB khi chạy thử.
//
// Terminal chỉ in tóm tắt; chi tiết (mỗi dòng một phiếu) ghi ra file Excel
// reports/dedupe-lark-twins-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn dedupe:lark-twins                     # chạy thử, không ghi
//   yarn dedupe:lark-twins --all               # in thêm toàn bộ chi tiết ra terminal
//   yarn dedupe:lark-twins --apply --user=<id> # ghi thật

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import { HN, SG } from '../../src/internal-finance/legacy-fund-reconcile';
import {
  applyTwinDedupe,
  fundBalance,
  planTwinDedupe,
} from '../../src/internal-finance/lark-twin-dedupe';
import {
  BRANCH_NAME,
  buildTwinReport,
  money,
  type ReportSheet,
} from '../../src/internal-finance/lark-twin-report';

async function writeWorkbook(sheets: ReportSheet[], title: string) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `dedupe-lark-twins-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  workbook.title = title;
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = sheet.columns;
    ws.getRow(1).font = { bold: true };
    for (const row of sheet.rows) ws.addRow(row);
    const amountColumn = sheet.columns.findIndex((c) => c.key === 'amount');
    if (amountColumn >= 0) ws.getColumn(amountColumn + 1).numFmt = '#,##0';
    if (sheet.rows.length && sheet.columns.length > 1)
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
      };
  }
  await workbook.xlsx.writeFile(file);
  return file;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  const userArg = process.argv.find((arg) => arg.startsWith('--user='));
  const userId = userArg ? Number(userArg.split('=')[1]) : NaN;
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

  const prisma = new PrismaClient();
  try {
    const before = await fundBalance(prisma);
    const plan = apply
      ? await applyTwinDedupe(prisma, userId)
      : await planTwinDedupe(prisma);
    const title = apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)';
    const { summary, sheets } = buildTwinReport(plan, before);

    console.log(title);
    console.log(summary.join('\n'));
    if (all)
      for (const sheet of sheets.slice(1)) {
        console.log(`\n----- ${sheet.name} (${sheet.rows.length}) -----`);
        for (const row of sheet.rows)
          console.log(
            sheet.columns.map((c) => String(row[c.key] ?? '')).join(' | '),
          );
      }
    if (apply) {
      const after = await fundBalance(prisma);
      for (const id of [HN, SG])
        console.log(
          `${BRANCH_NAME[id]} số dư sau khi ghi: ${money(after.get(id))}`,
        );
    }
    const file = await writeWorkbook(sheets, title);
    console.log(`\n📄 Chi tiết: ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌', error);
  process.exit(1);
});
