// prisma/scripts/fix-ledger-deploy.ts
//
// Sổ quỹ Lark Base đúng tới hết 13/10/2026, từ 14/10 (ngày deploy) quỹ kho
// theo POS. Xem src/internal-finance/ledger-deploy-cutoff.ts.
//   - Dòng sổ Lark 11–13/10: giữ; phiếu POS trùng được gắn dấu "đã ghi quỹ
//     trên Lark" để duyệt tuần / lập phiếu thu không ghi quỹ lần 2.
//   - Dòng sổ Lark từ 14/10: hủy, phiếu POS tự ghi quỹ.
// Chạy thử chỉ đọc DB. Chi tiết: reports/fix-ledger-deploy-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn fix:ledger-deploy                      # chạy thử, không ghi
//   yarn fix:ledger-deploy --apply --user=<id>  # ghi thật

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import {
  applyLedgerDeploy,
  canMark,
  fundBalances,
  loadLedgerDeploy,
  type LedgerMatch,
  type MatchKind,
} from '../../src/internal-finance/ledger-deploy-cutoff';

const KHO: Record<number, string> = { 6: 'Kho HN', 1: 'Kho SG' };
const BY: Record<MatchKind, string> = {
  HD: 'Mã hóa đơn',
  BIEN_SO: 'Biển số xe',
  TEN_KHACH: 'Tên khách',
  SO_TIEN: 'Số tiền + ngày',
};
const SOURCE: Record<string, string> = {
  PACKING_SLIP: 'Báo đơn',
  FUEL: 'Xăng dầu (Xe cộ)',
  VEHICLE_CARE: 'Chăm sóc xe (Xe cộ)',
  MANUAL_EXPENSE: 'Chi khác (Phiếu chi kho)',
  MANUAL_RECEIPT: 'Phiếu thu (Tiền mặt kho)',
};
const money = (value: number) => value.toLocaleString('vi-VN');
const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

function action(item: LedgerMatch) {
  if (!item.pos) return 'Chỉ có trên Lark Base: quỹ đã tính, không cần làm gì';
  if (canMark(item.pos))
    return 'Gắn dấu "đã ghi quỹ trên Lark": POS không ghi quỹ lại';
  if (
    item.pos.fundPosted ||
    (item.pos.direction === 'EXPENSE' && item.pos.cashIssued)
  )
    return 'POS ĐÃ GHI QUỸ: đang trùng, cần xem tay';
  if (item.pos.direction === 'RECEIPT' && item.pos.status === 'POSTED')
    return 'Đã lập phiếu thu nhưng POS không cộng quỹ: không cần làm gì';
  return 'Đã có dấu từ trước';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userArg = process.argv.find((arg) => arg.startsWith('--user='));
  const userId = userArg ? Number(userArg.split('=')[1]) : NaN;
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

  const prisma = new PrismaClient();
  try {
    const before = await fundBalances(prisma);
    const plan = apply
      ? await applyLedgerDeploy(prisma, userId)
      : await loadLedgerDeploy(prisma);
    const after = apply ? await fundBalances(prisma) : null;

    const toMark = plan.matches.filter((item) => item.pos && canMark(item.pos));
    const doubled = plan.matches.filter(
      (item) => item.pos && action(item).startsWith('POS ĐÃ GHI QUỸ'),
    );
    const larkOnly = plan.matches.filter((item) => !item.pos);
    const voidByBranch = (branchId: number) =>
      plan.voids
        .filter((row) => row.branchId === branchId)
        .reduce(
          (sum, row) =>
            sum +
            (['RECEIPT', 'TRANSFER_IN'].includes(row.transactionType)
              ? -1
              : 1) *
              Number(row.amount),
          0,
        );

    console.log(apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)');
    console.log(
      `Dòng sổ Lark 11–13/10 (giữ): ${plan.keep.length}. Ghép được phiếu POS: ${plan.matches.length - larkOnly.length}`,
    );
    console.log(
      `  - Sẽ gắn dấu "đã ghi quỹ trên Lark": ${toMark.length} phiếu (${money(
        toMark.reduce((sum, item) => sum + Number(item.ledger.amount), 0),
      )})`,
    );
    console.log(`  - POS đã ghi quỹ (đang trùng, xem tay): ${doubled.length}`);
    console.log(`  - Chỉ có trên Lark Base: ${larkOnly.length}`);
    console.log(
      `Phiếu POS trước 14/10 không trùng dòng sổ Lark nào (sẽ ghi quỹ theo POS, cần xem): ${plan.unmatchedPos.length}`,
    );
    const voidNoPos = plan.voidMatches.filter((item) => !item.pos);
    console.log(
      `Dòng sổ Lark từ 14/10: ${plan.voidMatches.length}. Hủy (có phiếu POS ghi quỹ thay): ${plan.voids.length} (${money(
        plan.voids.reduce((sum, row) => sum + Number(row.amount), 0),
      )}); giữ trên sổ Lark (POS chưa có phiếu): ${voidNoPos.length} (${money(
        voidNoPos.reduce((sum, item) => sum + Number(item.ledger.amount), 0),
      )})`,
    );
    for (const branchId of [6, 1]) {
      const expected = before[branchId] + voidByBranch(branchId);
      console.log(
        `${KHO[branchId]}: số dư ${money(before[branchId])} → ${money(
          after ? after[branchId] : expected,
        )}${after ? '' : ' (dự kiến)'}`,
      );
    }
    if (apply)
      console.log(`Đã gắn dấu ${'marked' in plan ? plan.marked : 0} phiếu.`);

    const file = await writeWorkbook(plan);
    console.log(`📄 Chi tiết: ${file}`);
    if (!apply)
      console.log(
        '👉 Xem file (nhất là sheet 2), đồng ý thì chạy lại với --apply --user=<id>.',
      );
  } finally {
    await prisma.$disconnect();
  }
}

async function writeWorkbook(
  plan: Awaited<ReturnType<typeof loadLedgerDeploy>>,
) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `fix-ledger-deploy-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  const addSheet = (
    name: string,
    columns: Array<{ header: string; key: string; width: number }>,
    rows: Array<Record<string, unknown>>,
  ) => {
    const ws = workbook.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    for (const row of rows) ws.addRow(row);
    if (columns.some((column) => column.key === 'amount'))
      ws.getColumn('amount').numFmt = '#,##0';
    if (rows.length)
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length },
      };
  };
  addSheet(
    '1 Dong Lark 11-13',
    [
      { header: 'Kho', key: 'kho', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Loại', key: 'type', width: 12 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Mã sổ Lark', key: 'code', width: 14 },
      { header: 'Nội dung', key: 'description', width: 60 },
      { header: 'Phiếu POS trùng', key: 'pos', width: 30 },
      { header: 'Nguồn POS', key: 'source', width: 22 },
      { header: 'Ngày phiếu POS', key: 'posDate', width: 14 },
      { header: 'Số tiền POS', key: 'posAmount', width: 14 },
      { header: 'Ghép theo', key: 'by', width: 16 },
      { header: 'Approval tuần', key: 'batch', width: 30 },
      { header: 'Sẽ làm', key: 'action', width: 50 },
    ],
    plan.matches.map((item) => ({
      kho: KHO[item.ledger.branchId],
      date: vnDate(item.ledger.occurredAt),
      type: item.ledger.transactionType === 'EXPENSE' ? 'Chi' : 'Thu',
      amount: Number(item.ledger.amount),
      code: item.ledger.code,
      description: item.ledger.description,
      pos: item.pos?.code || '',
      source: item.pos
        ? SOURCE[item.pos.sourceType] || item.pos.sourceType
        : '',
      posDate: item.pos ? vnDate(item.pos.occurredAt) : '',
      posAmount: item.pos ? Number(item.pos.amount) : '',
      by: item.by ? BY[item.by] : '',
      batch: item.pos?.batch || '',
      action: action(item),
    })),
  );
  addSheet(
    '2 Phieu POS khong trung',
    [
      { header: 'Kho', key: 'kho', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Loại', key: 'type', width: 10 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Mã phiếu POS', key: 'code', width: 30 },
      { header: 'Nguồn', key: 'source', width: 22 },
      { header: 'Nội dung', key: 'description', width: 60 },
      { header: 'Approval tuần', key: 'batch', width: 30 },
    ],
    plan.unmatchedPos.map((entry) => ({
      kho: KHO[entry.branchId],
      date: vnDate(entry.occurredAt),
      type: entry.direction === 'EXPENSE' ? 'Chi' : 'Thu',
      amount: Number(entry.amount),
      code: entry.code,
      source: SOURCE[entry.sourceType] || entry.sourceType,
      description: entry.description,
      batch: entry.batch || '',
    })),
  );
  addSheet(
    '3 Dong Lark tu 14-10',
    [
      { header: 'Kho', key: 'kho', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Loại', key: 'type', width: 10 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Mã sổ Lark', key: 'code', width: 14 },
      { header: 'Nội dung', key: 'description', width: 60 },
      { header: 'Phiếu POS ghi quỹ thay', key: 'pos', width: 32 },
      { header: 'Ngày phiếu POS', key: 'posDate', width: 14 },
      { header: 'Ghép theo', key: 'by', width: 16 },
    ],
    plan.voidMatches.map(({ ledger: row, pos, by }) => ({
      kho: KHO[row.branchId],
      date: vnDate(row.occurredAt),
      type: row.transactionType === 'EXPENSE' ? 'Chi' : 'Thu',
      amount: Number(row.amount),
      code: row.code,
      description: row.description,
      pos:
        pos?.code ||
        'Giữ trên sổ Lark: POS chưa có phiếu (đừng nhập thêm ở POS, sẽ trùng)',
      posDate: pos ? vnDate(pos.occurredAt) : '',
      by: by ? BY[by] : '',
    })),
  );
  await workbook.xlsx.writeFile(file);
  return file;
}

main().catch((error) => {
  console.error('❌ Lỗi:', error?.message || error);
  process.exit(1);
});
