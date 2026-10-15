// prisma/scripts/check-lark-fund.ts
//
// Kiểm tra (CHỈ ĐỌC) Quỹ nội bộ Kho HN và Kho SG trước khi đồng bộ đơn Lark
// Approval: sổ quỹ Lark Base đúng tới hết 13/10/2026, từ 14/10 (ngày dùng POS)
// quỹ do POS ghi (webhook đơn Lark, Approval tuần, Đã chi, phiếu thu tiền mặt kho).
//
//   1. Dòng sổ Lark Base có ngày từ 14/10 (đáng lẽ không có).
//   2. Đơn Lark ghi quỹ trước 14/10 trùng dòng sổ Lark Base (trừ / cộng 2 lần).
//   3. Đơn Lark tiền mặt kho duyệt từ 14/10: đã ghi quỹ chưa, có ghi 2 lần không.
//   4. Sự kiện webhook của 4 form bị bỏ từ 14/10.
//   5. Approval tuần đã duyệt mà còn phiếu chưa Đã chi (quỹ chưa trừ).
//   6. Tình trạng quỹ: ngày chốt sổ cuối, số dư, thu chi từ 14/10 theo nguồn.
//
// Không ghi gì vào DB. Chi tiết ghi ra reports/check-lark-fund-<ngày giờ>.xlsx.
//
// Cách chạy:
//   yarn check:lark-fund

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as lark from '@larksuiteoapi/node-sdk';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  APPROVAL_DEFINITIONS,
  PAYMENT_VOUCHER,
  readFundReceipt,
  readPaymentVoucherCash,
} from '../../src/approval-lifecycle/approval-lifecycle.constants';
import {
  LarkApprovalMirrorService,
  larkTime,
  parseForm,
  retryLark,
} from '../../src/approval-lifecycle/lark-approval-mirror.service';
// Từ 14/10 (ngày dùng POS) quỹ kho theo POS; tới hết 13/10 theo sổ Lark Base.
import { DEPLOY_CUTOFF as CUTOFF } from '../../src/internal-finance/ledger-deploy-cutoff';

const KHO: Record<number, string> = { 6: 'Kho HN', 1: 'Kho SG' };
const KHO_IDS = [6, 1];
const DAY = 86400000;
const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

const num = (value: Prisma.Decimal | number | null | undefined) =>
  Number(value || 0);
const money = (value: number) => value.toLocaleString('vi-VN');
const vnDate = (value: Date | null | undefined) =>
  value
    ? value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : '';
const incoming = (type: string) => ['RECEIPT', 'TRANSFER_IN'].includes(type);

type Sheet = {
  name: string;
  columns: Array<{ header: string; key: string; width: number }>;
  rows: Array<Record<string, unknown>>;
};

async function main() {
  const prisma = new PrismaClient();
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret)
    throw new Error('Thiếu LARK_APP_ID / LARK_APP_SECRET trong .env');
  const larkClient = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
    logger: silentLogger,
  });
  const mirror = new LarkApprovalMirrorService(
    null as any,
    larkClient,
    null as any,
    null as any,
  );
  const summary: string[] = [];
  const sheets: Sheet[] = [];

  try {
    // ---- 1. Dòng sổ Lark Base từ 14/10 ----
    const ledgerAfter = await prisma.internalFundTransaction.findMany({
      where: {
        branchId: { in: KHO_IDS },
        sourceType: 'LEDGER_HISTORY',
        status: 'POSTED',
        occurredAt: { gte: CUTOFF },
      },
      orderBy: { occurredAt: 'asc' },
    });
    // Ghép từng dòng với phiếu tạo trên POS (khác nguồn Lark): cùng kho, cùng
    // chiều thu/chi, cùng số tiền, lệch tối đa 1 ngày; mỗi phiếu chỉ ghép một lần.
    const posEntries = ledgerAfter.length
      ? await prisma.internalFinanceEntry.findMany({
          where: {
            branchId: { in: KHO_IDS },
            status: { not: 'CANCELLED' },
            sourceType: { notIn: ['LARK_IMPORT', 'LARK_APPROVAL'] },
            occurredAt: {
              gte: new Date(CUTOFF.getTime() - DAY),
              lt: new Date(
                Math.max(
                  ...ledgerAfter.map((row) => row.occurredAt.getTime()),
                ) +
                  2 * DAY,
              ),
            },
          },
          select: {
            id: true,
            code: true,
            branchId: true,
            direction: true,
            sourceType: true,
            amount: true,
            occurredAt: true,
            cashIssued: true,
            status: true,
            weeklyBatch: { select: { code: true, status: true } },
            fundTransaction: { select: { code: true, status: true } },
          },
        })
      : [];
    const used = new Set<number>();
    const POS_SOURCE: Record<string, string> = {
      PACKING_SLIP: 'Báo đơn',
      FUEL: 'Xăng dầu (Xe cộ)',
      VEHICLE_CARE: 'Chăm sóc xe (Xe cộ)',
      MANUAL_EXPENSE: 'Chi khác (Phiếu chi kho)',
      MANUAL_RECEIPT: 'Phiếu thu (Tiền mặt kho)',
    };
    const matched = ledgerAfter.map((row) => {
      const direction = incoming(row.transactionType) ? 'RECEIPT' : 'EXPENSE';
      const candidates = posEntries
        .filter(
          (entry) =>
            !used.has(entry.id) &&
            entry.branchId === row.branchId &&
            entry.direction === direction &&
            num(entry.amount) === num(row.amount) &&
            Math.abs(entry.occurredAt.getTime() - row.occurredAt.getTime()) <=
              DAY + 12 * 3600000,
        )
        .sort(
          (a, b) =>
            Math.abs(a.occurredAt.getTime() - row.occurredAt.getTime()) -
            Math.abs(b.occurredAt.getTime() - row.occurredAt.getTime()),
        );
      const pos = candidates[0] || null;
      if (pos) used.add(pos.id);
      const booked =
        pos?.fundTransaction?.status === 'POSTED' || Boolean(pos?.cashIssued);
      return { row, pos, booked };
    });
    const withPos = matched.filter((item) => item.pos);
    const bookedTwice = withPos.filter((item) => item.booked);
    summary.push(
      `1. Dòng sổ Lark Base có ngày từ 14/10: ${ledgerAfter.length} (đúng ra là 0). Có phiếu POS tương ứng: ${withPos.length}; trong đó POS đã ghi quỹ (đang trùng): ${bookedTwice.length} (${money(
        bookedTwice.reduce((sum, item) => sum + num(item.row.amount), 0),
      )}); chỉ có trên Lark Base: ${ledgerAfter.length - withPos.length}`,
    );
    sheets.push({
      name: '1 So Lark sau moc',
      columns: [
        { header: 'Kho', key: 'kho', width: 10 },
        { header: 'Ngày', key: 'date', width: 12 },
        { header: 'Loại', key: 'type', width: 14 },
        { header: 'Số tiền', key: 'amount', width: 14 },
        { header: 'Mã', key: 'code', width: 26 },
        { header: 'Nội dung', key: 'description', width: 50 },
        { header: 'Phiếu POS tương ứng', key: 'posCode', width: 30 },
        { header: 'Nguồn trên POS', key: 'posSource', width: 24 },
        { header: 'Approval tuần', key: 'batch', width: 30 },
        { header: 'POS đã ghi quỹ', key: 'booked', width: 16 },
      ],
      rows: matched.map(({ row, pos, booked }) => ({
        kho: KHO[row.branchId],
        date: vnDate(row.occurredAt),
        type: row.transactionType,
        amount: num(row.amount),
        code: row.code,
        description: row.description,
        posCode: pos?.code || 'Không có (chỉ trên Lark Base)',
        posSource: pos ? POS_SOURCE[pos.sourceType] || pos.sourceType : '',
        batch: pos?.weeklyBatch
          ? `${pos.weeklyBatch.code} (${pos.weeklyBatch.status})`
          : '',
        booked: pos ? (booked ? 'CÓ - đang trùng' : 'Chưa') : '',
      })),
    });

    // ---- 2. Đơn Lark ghi quỹ trước 14/10 ----
    const larkRows = await prisma.internalFundTransaction.findMany({
      where: {
        branchId: { in: KHO_IDS },
        status: 'POSTED',
        approvalRequest: { clientUuid: { startsWith: 'LARK:' } },
      },
      include: { approvalRequest: { select: { kind: true } } },
      orderBy: { occurredAt: 'asc' },
    });
    const larkBefore = larkRows.filter((row) => row.occurredAt < CUTOFF);
    const ledgerBefore = await prisma.internalFundTransaction.findMany({
      where: {
        branchId: { in: KHO_IDS },
        sourceType: 'LEDGER_HISTORY',
        status: 'POSTED',
        occurredAt: {
          gte: new Date(
            Math.min(...larkBefore.map((row) => row.occurredAt.getTime()), 0) -
              DAY,
          ),
        },
      },
      select: {
        branchId: true,
        transactionType: true,
        amount: true,
        occurredAt: true,
        code: true,
      },
    });
    const twinOf = (row: (typeof larkBefore)[number]) =>
      ledgerBefore.find(
        (ledger) =>
          ledger.branchId === row.branchId &&
          incoming(ledger.transactionType) === incoming(row.transactionType) &&
          num(ledger.amount) === num(row.amount) &&
          Math.abs(ledger.occurredAt.getTime() - row.occurredAt.getTime()) <=
            DAY + 12 * 3600000,
      );
    const beforeRows = larkBefore.map((row) => ({ row, twin: twinOf(row) }));
    const doubled = beforeRows.filter((item) => item.twin);
    summary.push(
      `2. Đơn Lark ghi quỹ trước 14/10: ${larkBefore.length} dòng, trong đó ${doubled.length} dòng trùng sổ Lark Base (${money(
        doubled.reduce((sum, item) => sum + num(item.row.amount), 0),
      )})`,
    );
    sheets.push({
      name: '2 Don Lark truoc moc',
      columns: [
        { header: 'Kho', key: 'kho', width: 10 },
        { header: 'Ngày', key: 'date', width: 12 },
        { header: 'Loại', key: 'type', width: 14 },
        { header: 'Số tiền', key: 'amount', width: 14 },
        { header: 'Mã giao dịch POS', key: 'code', width: 26 },
        { header: 'Nội dung', key: 'description', width: 50 },
        { header: 'Trùng dòng sổ Lark Base', key: 'twin', width: 26 },
      ],
      rows: beforeRows.map(({ row, twin }) => ({
        kho: KHO[row.branchId],
        date: vnDate(row.occurredAt),
        type: row.transactionType,
        amount: num(row.amount),
        code: row.code,
        description: row.description,
        twin: twin ? `${twin.code} (${vnDate(twin.occurredAt)})` : '',
      })),
    });

    // ---- 3. Đơn Lark tiền mặt kho duyệt từ 14/10 ----
    const codes = [
      PAYMENT_VOUCHER.approvalCode,
      APPROVAL_DEFINITIONS.RECEIPT.approvalCode,
    ];
    const orders: Array<Record<string, unknown>> = [];
    const counts = { ok: 0, missing: 0, twice: 0, mismatch: 0 };
    // Đơn duyệt từ 14/10 có thể được tạo trước đó: lấy đơn tạo trong 40 ngày trước mốc.
    const from = new Date(CUTOFF.getTime() - 40 * DAY);
    for (const approvalCode of codes) {
      const instanceCodes = await mirror.listInstanceCodes(
        approvalCode,
        from,
        new Date(),
      );
      process.stdout.write(
        `\r3. Đang đọc ${instanceCodes.length} đơn ${approvalCode === PAYMENT_VOUCHER.approvalCode ? 'PHIẾU CHI' : 'PHIẾU THU'}...      `,
      );
      for (const instanceCode of instanceCodes) {
        const response: any = await retryLark(() =>
          larkClient.approval.v4.instance.get({
            path: { instance_id: instanceCode },
            params: { locale: 'vi-VN', user_id_type: 'open_id' },
          }),
        );
        const detail = response?.data;
        const approvedAt = larkTime(detail?.end_time);
        if (detail?.status !== 'APPROVED' || !approvedAt || approvedAt < CUTOFF)
          continue;
        const form = parseForm(detail.form);
        // Quỹ kho đơn làm thay đổi và số tiền mong đợi (dấu theo chiều tiền).
        const expected = new Map<number, number>();
        let label = '';
        let description = '';
        if (approvalCode === PAYMENT_VOUCHER.approvalCode) {
          const cash = readPaymentVoucherCash(form);
          if (!cash || !KHO_IDS.includes(cash.branchId)) continue;
          expected.set(cash.branchId, -cash.amount);
          label = 'PHIẾU CHI';
          description = cash.description;
        } else {
          const receipt = readFundReceipt(form);
          if (!receipt) continue;
          if (receipt.kind === 'RECEIPT') {
            if (!KHO_IDS.includes(receipt.branchId)) continue;
            expected.set(receipt.branchId, receipt.amount);
          } else {
            if (KHO_IDS.includes(receipt.sourceBranchId))
              expected.set(receipt.sourceBranchId, -receipt.amount);
            if (KHO_IDS.includes(receipt.destinationBranchId))
              expected.set(receipt.destinationBranchId, receipt.amount);
            if (!expected.size) continue;
          }
          label = receipt.kind === 'RECEIPT' ? 'PHIẾU THU' : 'CHUYỂN QUỸ';
          description = receipt.description;
        }
        const request = await prisma.approvalRequest.findUnique({
          where: { instanceCode },
          select: { id: true },
        });
        const fundRows = request
          ? await prisma.internalFundTransaction.findMany({
              where: { approvalRequestId: request.id, status: 'POSTED' },
              select: {
                branchId: true,
                transactionType: true,
                amount: true,
                code: true,
                occurredAt: true,
              },
            })
          : [];
        for (const [branchId, amount] of expected) {
          const own = fundRows.filter((row) => row.branchId === branchId);
          const booked = own.reduce(
            (sum, row) =>
              sum + (incoming(row.transactionType) ? 1 : -1) * num(row.amount),
            0,
          );
          const status = !own.length
            ? 'missing'
            : own.length > 1
              ? 'twice'
              : booked !== amount
                ? 'mismatch'
                : 'ok';
          counts[status] += 1;
          orders.push({
            kho: KHO[branchId],
            form: label,
            approvedAt: vnDate(approvedAt),
            expected: amount,
            booked,
            result:
              status === 'ok'
                ? 'Đã ghi quỹ'
                : status === 'missing'
                  ? 'CHƯA GHI QUỸ'
                  : status === 'twice'
                    ? 'GHI 2 LẦN'
                    : 'LỆCH SỐ TIỀN',
            fundCodes: own.map((row) => row.code).join(', '),
            description,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    process.stdout.write('\n');
    summary.push(
      `3. Đơn Lark tiền mặt kho duyệt từ 14/10: đã ghi quỹ ${counts.ok}, CHƯA ghi ${counts.missing}, ghi 2 lần ${counts.twice}, lệch số tiền ${counts.mismatch}`,
    );
    sheets.push({
      name: '3 Don Lark tu 14-10',
      columns: [
        { header: 'Kho', key: 'kho', width: 10 },
        { header: 'Form', key: 'form', width: 14 },
        { header: 'Ngày duyệt', key: 'approvedAt', width: 12 },
        { header: 'Quỹ cần +/-', key: 'expected', width: 16 },
        { header: 'POS đã ghi +/-', key: 'booked', width: 16 },
        { header: 'Kết quả', key: 'result', width: 16 },
        { header: 'Mã giao dịch POS', key: 'fundCodes', width: 30 },
        { header: 'Nội dung', key: 'description', width: 50 },
      ],
      rows: orders,
    });

    // ---- 4. Sự kiện webhook bị bỏ ----
    const fourCodes = [
      PAYMENT_VOUCHER.approvalCode,
      APPROVAL_DEFINITIONS.RECEIPT.approvalCode,
      APPROVAL_DEFINITIONS.EXPENSE_HN.approvalCode,
      APPROVAL_DEFINITIONS.EXPENSE_SG.approvalCode,
    ];
    const orphans = await prisma.approvalRequestEvent.findMany({
      where: {
        approvalRequestId: null,
        approvalCode: { in: fourCodes },
        receivedAt: { gte: CUTOFF },
      },
      orderBy: { receivedAt: 'asc' },
      select: {
        instanceCode: true,
        approvalCode: true,
        status: true,
        receivedAt: true,
        error: true,
      },
    });
    const orphanInstances = new Set(orphans.map((row) => row.instanceCode));
    summary.push(
      `4. Sự kiện webhook không gắn được đơn POS từ 14/10: ${orphans.length} sự kiện, ${orphanInstances.size} đơn`,
    );
    const formName: Record<string, string> = {
      [PAYMENT_VOUCHER.approvalCode]: 'PHIẾU CHI',
      [APPROVAL_DEFINITIONS.RECEIPT.approvalCode]: 'PHIẾU THU',
      [APPROVAL_DEFINITIONS.EXPENSE_HN.approvalCode]: 'PHIẾU CHI KHO HN',
      [APPROVAL_DEFINITIONS.EXPENSE_SG.approvalCode]: 'PHIẾU CHI KHO SG',
    };
    sheets.push({
      name: '4 Webhook bi bo',
      columns: [
        { header: 'Form', key: 'form', width: 18 },
        { header: 'Trạng thái', key: 'status', width: 12 },
        { header: 'Nhận lúc', key: 'receivedAt', width: 20 },
        { header: 'Lỗi', key: 'error', width: 60 },
      ],
      rows: orphans.map((row) => ({
        form: formName[row.approvalCode] || row.approvalCode,
        status: row.status,
        receivedAt: row.receivedAt.toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
        }),
        error: row.error,
      })),
    });

    // ---- 5. Approval tuần đã duyệt nhưng còn phiếu chưa Đã chi ----
    const batches = await prisma.internalFinanceWeeklyBatch.findMany({
      where: {
        branchId: { in: KHO_IDS },
        approvalRequest: { status: 'APPROVED' },
        entries: {
          some: {
            cashIssued: false,
            status: { not: 'CANCELLED' },
          },
        },
      },
      select: {
        code: true,
        branchId: true,
        weekStart: true,
        totalAmount: true,
        approvalRequest: { select: { completedAt: true } },
        entries: {
          where: { cashIssued: false, status: { not: 'CANCELLED' } },
          select: { amount: true },
        },
      },
      orderBy: { weekStart: 'asc' },
    });
    summary.push(
      `5. Approval tuần đã duyệt còn phiếu chưa Đã chi: ${batches.length} tuần, ${money(
        batches.reduce(
          (sum, batch) =>
            sum + batch.entries.reduce((s, e) => s + num(e.amount), 0),
          0,
        ),
      )}`,
    );
    sheets.push({
      name: '5 Tuan chua tru quy',
      columns: [
        { header: 'Kho', key: 'kho', width: 10 },
        { header: 'Batch', key: 'code', width: 26 },
        { header: 'Tuần từ', key: 'weekStart', width: 12 },
        { header: 'Ngày duyệt', key: 'approvedAt', width: 12 },
        { header: 'Tổng batch', key: 'total', width: 14 },
        { header: 'Số phiếu chưa Đã chi', key: 'count', width: 18 },
        { header: 'Tiền chưa trừ quỹ', key: 'amount', width: 16 },
      ],
      rows: batches.map((batch) => ({
        kho: KHO[batch.branchId],
        code: batch.code,
        weekStart: vnDate(batch.weekStart),
        approvedAt: vnDate(batch.approvalRequest?.completedAt),
        total: num(batch.totalAmount),
        count: batch.entries.length,
        amount: batch.entries.reduce((sum, e) => sum + num(e.amount), 0),
      })),
    });

    // ---- 6. Tình trạng quỹ ----
    const fundRows: Array<Record<string, unknown>> = [];
    for (const branchId of KHO_IDS) {
      const [closing, totals, since] = await Promise.all([
        prisma.internalFundDailyClosing.findFirst({
          where: { branchId },
          orderBy: { closingDate: 'desc' },
          select: {
            closingDate: true,
            reconciliationStatus: true,
            systemClosingBalance: true,
          },
        }),
        prisma.internalFundTransaction.groupBy({
          by: ['transactionType'],
          where: { branchId, status: 'POSTED' },
          _sum: { amount: true },
        }),
        prisma.internalFundTransaction.groupBy({
          by: ['sourceType', 'transactionType'],
          where: { branchId, status: 'POSTED', occurredAt: { gte: CUTOFF } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
      ]);
      const balance = totals.reduce(
        (sum, row) =>
          sum + (incoming(row.transactionType) ? 1 : -1) * num(row._sum.amount),
        0,
      );
      summary.push(
        `6. ${KHO[branchId]}: số dư hiện tại ${money(balance)}; chốt sổ cuối ${
          closing
            ? `${closing.closingDate.toISOString().slice(0, 10)} (${closing.reconciliationStatus})`
            : 'chưa có'
        }; ${since.reduce((sum, row) => sum + row._count._all, 0)} giao dịch từ 14/10`,
      );
      for (const row of since)
        fundRows.push({
          kho: KHO[branchId],
          source: row.sourceType,
          type: row.transactionType,
          count: row._count._all,
          amount: num(row._sum.amount),
        });
    }
    sheets.push({
      name: '6 Quy tu 14-10',
      columns: [
        { header: 'Kho', key: 'kho', width: 10 },
        { header: 'Nguồn', key: 'source', width: 26 },
        { header: 'Loại', key: 'type', width: 14 },
        { header: 'Số giao dịch', key: 'count', width: 12 },
        { header: 'Tổng tiền', key: 'amount', width: 16 },
      ],
      rows: fundRows,
    });

    console.log('\n🔎 KIỂM TRA QUỸ KHO (chỉ đọc, không ghi DB)');
    for (const line of summary) console.log(line);
    const file = await writeWorkbook(sheets);
    console.log(`📄 Chi tiết: ${file}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function writeWorkbook(sheets: Sheet[]) {
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .replace(/[: ]/g, '-');
  const file = path.join(dir, `check-lark-fund-${stamp}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = sheet.columns;
    ws.getRow(1).font = { bold: true };
    for (const row of sheet.rows) ws.addRow(row);
    for (const column of sheet.columns)
      if (/Số tiền|Tổng|Tiền|\+\/-/.test(column.header))
        ws.getColumn(column.key).numFmt = '#,##0';
  }
  await workbook.xlsx.writeFile(file);
  return file;
}

main().catch((error) => {
  console.error('❌ Lỗi khi kiểm tra quỹ:', error?.message || error);
  process.exit(1);
});
