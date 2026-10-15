// prisma/scripts/fix-approved-weeks.ts
//
// Tuần Approval phiếu chi kho đã duyệt trên Lark nhưng POS ghi quỹ thiếu
// (phiếu thiếu tick bị gỡ khỏi tuần). Theo LarkBase: phiếu Lark tính vào tuần
// thì POS tick đủ, gắn vào tuần, ghi Đã chi và trừ quỹ vào ngày duyệt.
// Chỉ ĐỌC LarkBase. Mặc định chạy thử (liệt kê từng phiếu, không ghi DB).
// Xem src/internal-finance/approved-week-fix.ts.
//
// Cách chạy:
//   yarn fix:approved-weeks --branch=HN --year=2026 --weeks=37,38,39
//   yarn fix:approved-weeks --branch=HN --year=2026 --weeks=37,38,39 --apply --user=<id>

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaClient } from '@prisma/client';
import {
  readNumber,
  readText,
} from '../../src/internal-finance/legacy-fund-reconcile';
import {
  STATUS_LABEL,
  applyApprovedWeeks,
  fixAmount,
  mapLarkWeekRow,
  planApprovedWeeks,
  type WeekPlan,
} from '../../src/internal-finance/approved-week-fix';

const TABLES = {
  HN: {
    branchId: 6,
    expense: 'tblsU8sAtDJA9jHl',
    approval: 'tbljYaWkP1tyBjTk',
    name: 'Kho HN',
  },
  SG: {
    branchId: 1,
    expense: 'tblcNqgYpTpNwX2X',
    approval: 'tble63nBiGQWE5Fs',
    name: 'Kho SG',
  },
} as const;

const arg = (name: string, fallback = '') =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ||
  fallback;
const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
const vnTime = (date?: Date | null) =>
  date ? date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '-';

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

async function readTable(
  client: lark.Client,
  baseToken: string,
  tableId: string,
) {
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
  return records;
}

function report(plans: WeekPlan[], title: string) {
  const lines: string[] = [title];
  let total = 0;
  for (const plan of plans) {
    const fix = fixAmount(plan);
    total += fix;
    lines.push(
      '',
      `== Tuần ${plan.week}/${plan.year}: Lark duyệt ${money(plan.larkAmount)}đ — POS đã ghi quỹ ${money(plan.posPosted)}đ — thiếu ${money(plan.larkAmount - plan.posPosted)}đ`,
      `   Duyệt lúc: ${vnTime(plan.request?.completedAt)}; tuần POS: ${plan.batch?.code || 'KHÔNG TÌM THẤY'}`,
      `   Dòng Lark của tuần: tất cả ${money(plan.larkAllRows)}đ, đủ hai tick ${money(plan.larkCheckedRows)}đ → dùng: ${
        plan.rowSet === 'all'
          ? 'tất cả'
          : plan.rowSet === 'checked'
            ? 'đủ hai tick'
            : 'KHÔNG KHỚP số Approval, tuần này sẽ không sửa'
      }`,
      `   Sẽ trừ thêm vào quỹ: ${money(fix)}đ`,
    );
    for (const line of plan.lines.filter((l) => l.status !== 'issued'))
      lines.push(
        `   - ${STATUS_LABEL[line.status]}: ${line.entry?.code || '(không có)'} | ${line.lark.day} | ${money(line.lark.amount)}đ | ${line.lark.content}${line.lark.note ? ' | ' + line.lark.note : ''}${line.ledgerRecorded ? ' | đã trừ trên Lark: chỉ tick' : ''}`,
      );
  }
  lines.push('', `TỔNG sẽ trừ thêm vào quỹ: ${money(total)}đ`);
  return lines;
}

async function main() {
  const key = arg('branch', 'HN').toUpperCase() as 'HN' | 'SG';
  const table = TABLES[key];
  if (!table) throw new Error('--branch phải là HN hoặc SG');
  const year = Number(arg('year', '2026'));
  const weekList = arg('weeks').split(',').map(Number).filter(Boolean);
  if (!weekList.length) throw new Error('Cần --weeks=37,38,39');
  const apply = process.argv.includes('--apply');
  const userId = Number(arg('user'));
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

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

  const approvals = await readTable(client, baseToken, table.approval);
  const weeks = approvals
    .map((row) => ({
      week: readNumber(row.fields['Tuần chi']),
      year: Number(readText(row.fields['Năm chi'])),
      amount: readNumber(row.fields['Số tiền']),
      instanceCode: readText(row.fields['instance_code_1']).trim(),
      status: readText(row.fields['Trạng thái duyệt']),
    }))
    .filter(
      (row) =>
        row.year === year && weekList.includes(row.week) && row.instanceCode,
    );
  for (const week of weekList)
    if (!weeks.some((row) => row.week === week))
      console.warn(`⚠️ Không thấy Approval tuần ${week}/${year} trên Lark`);
  const larkRows = (await readTable(client, baseToken, table.expense)).map(
    mapLarkWeekRow,
  );

  const input = {
    branchId: table.branchId,
    tableId: table.expense,
    baseToken,
    year,
    weeks,
    larkRows,
  };
  const prisma = new PrismaClient();
  try {
    const plans = apply
      ? await applyApprovedWeeks(prisma, input, userId)
      : await planApprovedWeeks(prisma, input);
    const lines = report(
      plans,
      `${apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)'} — ${table.name}, tuần ${weekList.join(', ')}/${year}`,
    );
    console.log(lines.join('\n'));

    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Tóm tắt');
    summary.columns = [{ header: 'Tóm tắt', key: 'line', width: 140 }];
    lines.forEach((line) => summary.addRow({ line }));
    const ws = workbook.addWorksheet('Từng phiếu', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Tuần', key: 'week', width: 8 },
      { header: 'Ngày Lark', key: 'day', width: 12 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Nội dung Lark', key: 'content', width: 45 },
      { header: 'Ghi chú Lark', key: 'note', width: 35 },
      { header: 'Mã phiếu POS', key: 'code', width: 30 },
      { header: 'Nội dung POS', key: 'posText', width: 40 },
      { header: 'Ghép theo', key: 'via', width: 16 },
      { header: 'Trạng thái / việc làm', key: 'status', width: 48 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const plan of plans)
      for (const line of plan.lines)
        ws.addRow({
          week: plan.week,
          day: line.lark.day,
          amount: line.lark.amount,
          content: line.lark.content,
          note: line.lark.note,
          code: line.entry?.code || '',
          posText: line.entry?.description || '',
          via:
            line.via === 'record'
              ? 'Cùng dòng Lark'
              : line.via === 'merged'
                ? 'Phiếu xe đã gộp'
                : line.via === 'vehicle'
                  ? 'Phiếu xe giữ thay'
                  : '',
          status:
            STATUS_LABEL[line.status] +
            (line.ledgerRecorded ? ' (đã trừ trên Lark: chỉ tick)' : ''),
        });
    ws.getColumn('amount').numFmt = '#,##0';
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };
    const dir = path.resolve(__dirname, '../../reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date()
      .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
      .replace(/[: ]/g, '-');
    const file = path.join(dir, `fix-approved-weeks-${key}-${stamp}.xlsx`);
    await workbook.xlsx.writeFile(file);
    console.log(`\n📄 Chi tiết: ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌', error?.message || error);
  process.exit(1);
});
