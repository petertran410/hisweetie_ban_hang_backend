// prisma/scripts/sync-lark-approvals.ts
//
// Lấy bù các đơn PHIẾU THU / PHIẾU CHI / PHIẾU CHI KHO HN, SG mà nhân viên tạo
// trực tiếp trên Lark Approval: lưu bản sao (trang "Đơn Lark Approval"); đơn
// tiền mặt Kho HN / SG đã duyệt thì ghi quỹ như webhook và tạo dòng Đã chi /
// Đã thu ở Tài chính nội bộ (không vào Phiếu chi kho). Đơn duyệt trước
// 14/10/2026 chỉ tạo dòng, không ghi quỹ (sổ quỹ Lark đã có). Không ghi quỹ văn
// phòng. PHIẾU CHI KHO tạo trên Lark chỉ lưu bản sao. Chạy thử chỉ đọc.
//
// Terminal in tóm tắt; chi tiết từng đơn ghi ra
// reports/sync-lark-approvals-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn sync:lark-approvals                       # chạy thử, không ghi
//   yarn sync:lark-approvals --from=2025-01-01     # chỉ đơn tạo từ ngày này
//   yarn sync:lark-approvals --apply               # ghi thật, bỏ qua đơn nghi trùng
//   yarn sync:lark-approvals --apply --include-suspect

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as lark from '@larksuiteoapi/node-sdk';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InternalFundLedgerService } from '../../src/internal-fund/internal-fund-ledger.service';
import { InternalFinanceCodeService } from '../../src/internal-finance/internal-finance-code.service';
import { ApprovalLifecycleService } from '../../src/approval-lifecycle/approval-lifecycle.service';
import {
  LarkApprovalMirrorService,
  retryLark,
} from '../../src/approval-lifecycle/lark-approval-mirror.service';
import type { LarkFormKind } from '../../src/approval-lifecycle/approval-lifecycle.constants';

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

const FORM_LABELS: Record<LarkFormKind, string> = {
  PHIEU_THU: 'PHIẾU THU',
  PHIEU_CHI: 'PHIẾU CHI',
  PHIEU_CHI_KHO_HN: 'PHIẾU CHI KHO HN',
  PHIEU_CHI_KHO_SG: 'PHIẾU CHI KHO SG',
};
const BRANCH_LABELS: Record<number, string> = {
  6: 'Kho HN',
  1: 'Kho SG',
  4: 'VP HN',
  7: 'VP HCM',
};
const DEFAULT_FROM = '2024-11-01';
/** Lấy bù chỉ ghi quỹ Kho HN (6) và Kho SG (1); quỹ văn phòng để người dùng tự xem. */
const FUND_BRANCHES = [6, 1];

const arg = (name: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1];
const vnDate = (value: Date | null | undefined) =>
  value
    ? value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : '';
const money = (value: number) => value.toLocaleString('vi-VN');

async function main() {
  const apply = process.argv.includes('--apply');
  const includeSuspect = process.argv.includes('--include-suspect');
  const fromKey = arg('from') || DEFAULT_FROM;
  const from = new Date(`${fromKey}T00:00:00+07:00`);
  if (Number.isNaN(from.getTime()))
    throw new Error('--from phải là YYYY-MM-DD');

  const config = new ConfigService();
  const appId = config.get<string>('LARK_APP_ID');
  const appSecret = config.get<string>('LARK_APP_SECRET');
  if (!appId || !appSecret)
    throw new Error('Thiếu LARK_APP_ID / LARK_APP_SECRET trong .env');
  const larkClient = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
    // Lỗi đã được thử lại và ghi vào báo cáo; không in log thô của SDK.
    logger: silentLogger,
  });
  const prisma = new PrismaService();
  const ledger = new InternalFundLedgerService();
  const mirror = new LarkApprovalMirrorService(
    prisma,
    larkClient,
    ledger,
    new InternalFinanceCodeService(),
  );
  const approval = new ApprovalLifecycleService(
    prisma,
    config,
    larkClient,
    ledger,
    mirror,
  );

  const rows: Array<Record<string, unknown>> = [];
  const counts = new Map<string, number>();
  const bump = (key: string, by = 1) =>
    counts.set(key, (counts.get(key) || 0) + by);
  let entryAmount = 0;
  /** Đơn sẽ ghi quỹ mới (duyệt từ 14/10/2026, POS chưa có). */
  const fundPosts: Array<{
    branch: string;
    date: string;
    amount: number;
    receipt: boolean;
    description: string;
  }> = [];

  const userNames = new Map<string, Promise<string>>();
  const requesterName = (openId: string | null) => {
    if (!openId) return Promise.resolve('');
    if (!userNames.has(openId))
      userNames.set(
        openId,
        prisma.user
          .findFirst({ where: { larkUserId: openId }, select: { name: true } })
          .then((user) => user?.name || ''),
      );
    return userNames.get(openId)!;
  };

  const handle = async (
    instanceCode: string,
    approvalCode: string,
    label: string,
  ) => {
    const preview = await retryLark(() =>
      approval.previewLarkInstance(instanceCode, approvalCode, FUND_BRANCHES),
    );
    if (!preview || preview.outcome === 'POS') {
      bump(`${label} · đơn POS gửi (bỏ qua)`);
      return;
    }
    const { summary, suspectDuplicateOfId } = preview;
    const amount = summary.cashAmount ?? summary.amount ?? 0;
    const approved = preview.status === 'APPROVED';
    const suspect = Boolean(suspectDuplicateOfId) && !includeSuspect;
    let result: string;
    if (preview.existingEntry) result = 'Đã có dòng Tài chính nội bộ';
    else if (!approved) result = `Chưa ghi nhận: Lark ${preview.status || '?'}`;
    else if (!summary.inScope) result = `Chỉ xem: ${summary.skipReason || ''}`;
    else if (suspect && !preview.existingRequest)
      result = 'Bỏ qua: có thể trùng phiếu POS';
    else if (preview.fund === 'ledger')
      result = 'Tạo dòng TCNB (quỹ Lark đã ghi, không ghi quỹ)';
    else if (preview.fund === 'existing')
      result = 'Tạo dòng TCNB (gắn giao dịch quỹ đã có)';
    else result = 'Tạo dòng TCNB + ghi quỹ';
    if (preview.fund === 'post' && !(suspect && !preview.existingRequest))
      fundPosts.push({
        branch: summary.branchId ? BRANCH_LABELS[summary.branchId] || '' : '',
        date: vnDate(preview.completedAt),
        amount,
        receipt: summary.direction === 'RECEIPT',
        description: summary.description || '',
      });
    if (result.startsWith('Tạo dòng')) entryAmount += amount;
    bump(`${label} · ${result}`);

    const [suspectEntry, requester] = await Promise.all([
      suspectDuplicateOfId
        ? prisma.internalFinanceEntry.findUnique({
            where: { id: suspectDuplicateOfId },
            select: { code: true },
          })
        : null,
      requesterName(preview.requesterOpenId),
    ]);
    rows.push({
      form: label,
      status: preview.status,
      occurredAt: vnDate(summary.occurredAt),
      completedAt: vnDate(preview.completedAt),
      branch: summary.branchId ? BRANCH_LABELS[summary.branchId] || '' : '',
      amount,
      method: summary.method || '',
      cashSource: summary.cashSource || '',
      description: summary.description || '',
      requester,
      result,
      suspect: suspectEntry?.code || '',
    });

    if (apply)
      await approval.syncLarkInstance(instanceCode, approvalCode, {
        skipSuspect: !includeSuspect,
        knownDetail: preview.detail,
        fundBranches: FUND_BRANCHES,
      });
  };

  try {
    // Lấy danh sách mã đơn của cả 4 form trước, rồi xử lý song song.
    const jobs: Array<{
      instanceCode: string;
      approvalCode: string;
      label: string;
    }> = [];
    for (const approvalCode of approval.larkApprovalCodes()) {
      const label = FORM_LABELS[approval.larkFormKind(approvalCode)!];
      const codes = await mirror.listInstanceCodes(
        approvalCode,
        from,
        new Date(),
      );
      console.log(`${label}: ${codes.length} đơn trên Lark`);
      for (const instanceCode of codes)
        jobs.push({ instanceCode, approvalCode, label });
    }

    // Ghi thật chạy ít luồng hơn để giảm tranh khóa quỹ.
    // Lark giới hạn số lần gọi mỗi phút: chạy vừa phải, gặp giới hạn thì tự chờ.
    const workers = apply ? 2 : 4;
    const startedAt = Date.now();
    let done = 0;
    let next = 0;
    const progress = () => {
      const seconds = (Date.now() - startedAt) / 1000;
      const left = done ? ((jobs.length - done) * seconds) / done : 0;
      process.stdout.write(
        `\r⏳ ${done}/${jobs.length} đơn · còn khoảng ${Math.ceil(left / 60)} phút   `,
      );
    };
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          try {
            await handle(job.instanceCode, job.approvalCode, job.label);
          } catch (error: any) {
            bump(`${job.label} · lỗi`);
            rows.push({ form: job.label, result: `Lỗi: ${error?.message}` });
          }
          done += 1;
          if (done % 10 === 0 || done === jobs.length) progress();
        }
      }),
    );
    process.stdout.write('\n');

    console.log(apply ? '\n✅ ĐÃ GHI THẬT' : '\n🔎 CHẠY THỬ (không ghi DB)');
    console.log(`Đơn tạo từ ${fromKey} đến nay`);
    for (const [key, value] of [...counts.entries()].sort())
      console.log(`  ${key}: ${value}`);
    console.log(
      `Tổng tiền dòng Tài chính nội bộ tạo mới: ${money(entryAmount)}`,
    );
    console.log(
      `\nGhi quỹ kho mới (đơn duyệt từ 14/10/2026 mà POS chưa có): ${fundPosts.length} đơn`,
    );
    for (const branch of ['Kho HN', 'Kho SG']) {
      const own = fundPosts.filter((post) => post.branch === branch);
      if (!own.length) continue;
      const net = own.reduce(
        (sum, post) => sum + (post.receipt ? post.amount : -post.amount),
        0,
      );
      console.log(`  ${branch}: ${net >= 0 ? '+' : ''}${money(net)}`);
      for (const post of own)
        console.log(
          `    ${post.date} ${post.receipt ? 'Thu +' : 'Chi -'}${money(post.amount)} · ${post.description.slice(0, 70)}`,
        );
    }

    const file = await writeWorkbook(rows);
    console.log(`📄 Chi tiết: ${file}`);
    if (!apply)
      console.log(
        '👉 Xem file chi tiết, đồng ý thì chạy lại với --apply (thêm --include-suspect để nhận cả đơn nghi trùng).',
      );
  } finally {
    await prisma.$disconnect();
  }
}

async function writeWorkbook(rows: Array<Record<string, unknown>>) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `sync-lark-approvals-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Đơn Lark', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = [
    { header: 'Form', key: 'form', width: 20 },
    { header: 'Trạng thái Lark', key: 'status', width: 14 },
    { header: 'Ngày chi / thu', key: 'occurredAt', width: 14 },
    { header: 'Ngày duyệt', key: 'completedAt', width: 14 },
    { header: 'Quỹ', key: 'branch', width: 10 },
    { header: 'Số tiền', key: 'amount', width: 14 },
    { header: 'Phương thức', key: 'method', width: 18 },
    { header: 'Nguồn tiền', key: 'cashSource', width: 22 },
    { header: 'Nội dung', key: 'description', width: 50 },
    { header: 'Người đề xuất', key: 'requester', width: 22 },
    { header: 'Kết quả', key: 'result', width: 44 },
    { header: 'Có thể trùng phiếu', key: 'suspect', width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
  ws.getColumn('amount').numFmt = '#,##0';
  if (rows.length)
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };
  await workbook.xlsx.writeFile(file);
  return file;
}

main().catch((error) => {
  console.error('❌ Lỗi khi lấy bù đơn Lark:', error);
  process.exit(1);
});
