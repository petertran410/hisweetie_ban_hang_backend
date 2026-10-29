// prisma/scripts/import-vphn-ledger.ts
//
// Văn phòng HN: chép sổ quỹ LarkBase ("Giao Dịch Tiền Mặt - Kho", chi nhánh
// "Văn Phòng Hà Nội") vào Quỹ nội bộ tới hết 31/10/2026 và hủy các dòng POS tự
// ghi theo đơn Lark trong cùng khoảng (tránh tính hai lần). Xem
// src/internal-finance/vphn-ledger-import.ts. Chỉ ĐỌC LarkBase. Chạy lại
// được nhiều lần. Chi tiết: reports/import-vphn-ledger-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn import:vphn-ledger                        # chạy thử tới hết 31/10
//   yarn import:vphn-ledger --to=2026-10-31        # đổi ngày cuối
//   yarn import:vphn-ledger --apply --user=<id>    # ghi thật

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaClient } from '@prisma/client';
import type { LarkRecord } from '../../src/internal-finance/legacy-fund-reconcile';
import {
  applyVphnImport,
  planVphnImport,
  untilOf,
  vphnFundBalance,
  type VphnImportPlan,
} from '../../src/internal-finance/vphn-ledger-import';

const LEDGER_TABLE = process.env.LARK_FUND_LEDGER_TABLE || 'tblltz1Zcxe479UG';

const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
const vnDate = (value: Date | null | undefined) =>
  value
    ? value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : '';
const arg = (name: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1];

async function readLedger(): Promise<LarkRecord[]> {
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
  const records: LarkRecord[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.bitable.appTableRecord.list({
      path: { app_token: baseToken, table_id: LEDGER_TABLE },
      params: {
        page_size: 500,
        automatic_fields: true,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code && res.code !== 0)
      throw new Error(`LarkBase trả lỗi ${res.code}: ${res.msg ?? ''}`);
    for (const item of res.data?.items ?? []) {
      if (!item.record_id) continue;
      const created = Number((item as any).created_time);
      const modified = Number((item as any).last_modified_time);
      records.push({
        recordId: item.record_id,
        fields: (item.fields ?? {}) as Record<string, unknown>,
        createdAt: created > 0 ? new Date(created) : null,
        modifiedAt: modified > 0 ? new Date(modified) : null,
      });
    }
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return records;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userId = Number(arg('user'));
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');
  const until = untilOf(arg('to'));
  const untilLabel = vnDate(new Date(until.getTime() - 1));

  const prisma = new PrismaClient();
  try {
    const records = await readLedger();
    console.log(`Đọc ${records.length} dòng sổ quỹ trên LarkBase.`);
    const nowBefore = await vphnFundBalance(prisma);
    const plan = apply
      ? await applyVphnImport(prisma, records, userId, until)
      : await planVphnImport(prisma, records, until);
    const nowAfter = apply ? await vphnFundBalance(prisma) : null;

    const total = (rows: Array<{ amount: unknown }>) =>
      money(rows.reduce((sum, row) => sum + Number(row.amount), 0));
    const unmatched = plan.voids.filter((item) => !item.twin);
    console.log(apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)');
    console.log(`Sổ quỹ VPHN tới hết ${untilLabel}`);
    console.log(
      `  - Dòng Lark đã có trên POS: ${plan.existing.length} (${total(plan.existing)})`,
    );
    console.log(
      `  - Dòng Lark sẽ thêm: ${plan.add.length} (${total(plan.add)})`,
    );
    console.log(
      `  - Dòng Lark không tính vào quỹ (bỏ qua): ${plan.skipped.length}`,
    );
    console.log(
      `  - Dòng POS tự ghi sẽ hủy: ${plan.voids.length} (${total(plan.voids.map((item) => item.pos))})` +
        (unmatched.length
          ? ` — ${unmatched.length} dòng KHÔNG tìm thấy dòng Lark cùng khoản, xem file`
          : ''),
    );
    console.log(
      `Số dư tới hết ${untilLabel}: Lark ${money(plan.larkBalance)} | POS ${money(plan.posBefore)} → ${money(plan.posAfter)} (lệch sau áp dụng: ${money(plan.posAfter.minus(plan.larkBalance))})`,
    );
    console.log(
      `Số dư hiện tại: ${money(nowBefore)} → ${money(nowAfter ?? nowBefore.plus(plan.posAfter).minus(plan.posBefore))}${nowAfter === null ? ' (dự kiến)' : ''}`,
    );
    const file = await writeWorkbook(plan);
    console.log(`📄 Chi tiết: ${file}`);
    if (!apply)
      console.log('👉 Xem file, đồng ý thì chạy lại với --apply --user=<id>.');
  } finally {
    await prisma.$disconnect();
  }
}

async function writeWorkbook(plan: VphnImportPlan) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `import-vphn-ledger-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();

  const addSheet = workbook.addWorksheet('Them vao POS', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  addSheet.columns = [
    { header: 'Mã', key: 'code', width: 16 },
    { header: 'Ngày', key: 'date', width: 12 },
    { header: 'Loại', key: 'type', width: 14 },
    { header: 'Số tiền', key: 'amount', width: 16 },
    { header: 'Nội dung', key: 'description', width: 60 },
  ];
  for (const row of plan.add)
    addSheet.addRow({
      code: row.code,
      date: vnDate(row.occurredAt),
      type: row.transactionType,
      amount: Number(row.amount),
      description: row.description,
    });

  const voidSheet = workbook.addWorksheet('Huy dong POS', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  voidSheet.columns = [
    { header: 'Mã POS', key: 'code', width: 22 },
    { header: 'Ngày', key: 'date', width: 12 },
    { header: 'Loại', key: 'type', width: 14 },
    { header: 'Số tiền', key: 'amount', width: 16 },
    { header: 'Nguồn', key: 'source', width: 24 },
    { header: 'Nội dung', key: 'description', width: 50 },
    { header: 'Dòng Lark cùng khoản', key: 'twin', width: 22 },
    { header: 'Ngày Lark', key: 'twinDate', width: 12 },
  ];
  for (const { pos, twin } of plan.voids)
    voidSheet.addRow({
      code: pos.code,
      date: vnDate(pos.occurredAt),
      type: pos.transactionType,
      amount: Number(pos.amount),
      source: pos.sourceType,
      description: pos.description || '',
      twin: twin ? twin.code : 'KHÔNG TÌM THẤY',
      twinDate: twin ? vnDate(twin.occurredAt) : '',
    });

  const skipSheet = workbook.addWorksheet('Lark bo qua', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  skipSheet.columns = [
    { header: 'Mã', key: 'code', width: 22 },
    { header: 'Ngày', key: 'date', width: 12 },
    { header: 'Số tiền', key: 'amount', width: 16 },
    { header: 'Nội dung', key: 'description', width: 50 },
    { header: 'Lý do', key: 'reason', width: 40 },
  ];
  for (const row of plan.skipped)
    skipSheet.addRow({
      code: row.code,
      date: vnDate(row.occurredAt),
      amount: row.amount,
      description: row.description,
      reason: row.reason,
    });

  const balanceSheet = workbook.addWorksheet('So du');
  balanceSheet.columns = [
    { header: 'Chỉ tiêu', key: 'label', width: 40 },
    { header: 'Số tiền', key: 'value', width: 20 },
  ];
  balanceSheet.addRows([
    { label: 'Số dư sổ Lark tới mốc', value: Number(plan.larkBalance) },
    { label: 'Số dư POS tới mốc (trước)', value: Number(plan.posBefore) },
    { label: 'Số dư POS tới mốc (sau)', value: Number(plan.posAfter) },
    {
      label: 'Lệch sau áp dụng (POS − Lark)',
      value: Number(plan.posAfter.minus(plan.larkBalance)),
    },
  ]);

  // Chỉ 3 sheet đầu có cột `amount`; gọi getColumn với khóa không có sẽ lỗi.
  for (const sheet of [addSheet, voidSheet, skipSheet]) {
    sheet.getRow(1).font = { bold: true };
    sheet.getColumn('amount').numFmt = '#,##0';
  }
  balanceSheet.getRow(1).font = { bold: true };
  balanceSheet.getColumn('value').numFmt = '#,##0';
  await workbook.xlsx.writeFile(file);
  return file;
}

main().catch((error) => {
  console.error('❌ Lỗi:', error?.message || error);
  process.exit(1);
});
