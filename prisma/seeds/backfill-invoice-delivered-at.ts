// prisma/seeds/backfill-invoice-delivered-at.ts
//
// Điền `invoices.delivered_at` cho dữ liệu cũ từ nguồn đáng tin cậy nhất:
//   1. Thời điểm phiếu GIAO HÀNG sớm nhất còn hiệu lực (cancelled_at IS NULL).
//   2. Với luồng cũ bấm "Đã Báo Đơn" trực tiếp trên hóa đơn (không có phiếu
//      giao), thời điểm audit INVOICE_UPDATE đầu tiên ghi trạng thái DELIVERED.
//
// AN TOÀN:
//   - CHỈ ghi đúng một cột `delivered_at`. Không đụng cột nào khác.
//   - Chỉ ghi khi giá trị hiện tại khác giá trị đúng (idempotent, chạy lại vô hại).
//   - Bỏ qua hóa đơn đã hủy (status = 2).
//   - Không xóa, không reset bất cứ thứ gì.
//
// Chạy: npx ts-node prisma/seeds/backfill-invoice-delivered-at.ts
// Xem trước không ghi: thêm biến môi trường DRY_RUN=1

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';
// PostgreSQL giới hạn 32.767 bind variables mỗi prepared statement. Giữ batch
// nhỏ để các mệnh đề `IN (...)` của dữ liệu/audit không chạm giới hạn này.
const READ_BATCH_SIZE = 1_000;

async function main() {
  console.log(
    `🌱 Backfill invoices.delivered_at${DRY_RUN ? ' (DRY RUN — không ghi)' : ''}`,
  );

  // Mốc đúng của từng hóa đơn: phiếu giao chưa hủy sớm nhất.
  const rows = await prisma.$queryRaw<
    Array<{ invoiceId: number; firstDelivered: Date }>
  >`
    SELECT psi."invoiceId"          AS "invoiceId",
           MIN(ps."createdAt")      AS "firstDelivered"
    FROM packing_slip_invoices psi
    JOIN packing_slips ps ON ps.id = psi."packingSlipId"
    WHERE psi."invoiceId" IS NOT NULL
      AND ps."cancelledAt" IS NULL
    GROUP BY psi."invoiceId"
  `;

  console.log(`   Tìm thấy ${rows.length} hóa đơn có phiếu giao còn hiệu lực`);

  // Các hóa đơn được báo đơn trực tiếp trước khi có `deliveredAt` không có
  // PackingSlip để xuất hiện trong query trên. Trạng thái COMPLETED được giữ
  // lại vì hóa đơn có thể đã báo đơn rồi mới được kết thúc; audit bên dưới vẫn
  // chỉ chấp nhận lần chuyển sang GIAO THÀNH CÔNG làm mốc giao hàng.
  const directReportedCandidates = await prisma.invoice.findMany({
    where: {
      deliveredAt: null,
      status: { in: [1, 7] },
    },
    select: { id: true, code: true, status: true, deliveredAt: true },
  });
  const invoiceIds = [
    ...new Set([
      ...rows.map((r) => r.invoiceId),
      ...directReportedCandidates.map((inv) => inv.id),
    ]),
  ];

  if (invoiceIds.length === 0) {
    console.log('   Không có gì để làm.');
    return;
  }

  // Candidate báo đơn trực tiếp đã có đủ dữ liệu hiện tại. Chỉ cần đọc thêm
  // các invoice đi từ phiếu giao, đồng thời chia batch để không vượt bind limit.
  const currentMap = new Map(
    directReportedCandidates.map((invoice) => [invoice.id, invoice]),
  );
  const packingInvoiceIds = [...new Set(rows.map((row) => row.invoiceId))];
  for (
    let offset = 0;
    offset < packingInvoiceIds.length;
    offset += READ_BATCH_SIZE
  ) {
    const invoices = await prisma.invoice.findMany({
      where: {
        id: {
          in: packingInvoiceIds.slice(offset, offset + READ_BATCH_SIZE),
        },
      },
      select: { id: true, code: true, status: true, deliveredAt: true },
    });
    for (const invoice of invoices) currentMap.set(invoice.id, invoice);
  }

  const packingDeliveredAt = new Map(
    rows.map((row) => [row.invoiceId, row.firstDelivered]),
  );
  const directReportedAt = new Map<number, Date>();
  const directReportedIds = directReportedCandidates.map((invoice) => invoice.id);
  if (directReportedIds.length > 0) {
    console.log(
      `   Kiểm tra audit báo đơn trực tiếp cho ${directReportedIds.length} hóa đơn...`,
    );
  }
  for (
    let offset = 0;
    offset < directReportedIds.length;
    offset += READ_BATCH_SIZE
  ) {
    const directReportAuditLogs = await prisma.auditLog.findMany({
      where: {
        entityType: 'invoices',
        entityId: {
          in: directReportedIds
            .slice(offset, offset + READ_BATCH_SIZE)
            .map(String),
        },
        actionCode: 'INVOICE_UPDATE',
      },
      select: { entityId: true, createdAt: true, snapshot: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const log of directReportAuditLogs) {
      const invoiceId = Number(log.entityId);
      const snapshot = log.snapshot as
        | { status?: unknown; statusValue?: unknown }
        | null;
      const wasReportedDelivered =
        snapshot?.status === 7 || snapshot?.statusValue === 'Giao thành công';
      if (
        Number.isInteger(invoiceId) &&
        wasReportedDelivered &&
        !directReportedAt.has(invoiceId)
      ) {
        directReportedAt.set(invoiceId, log.createdAt);
      }
    }
  }

  let updated = 0;
  let skipped = 0;

  for (const invoiceId of invoiceIds) {
    const inv = currentMap.get(invoiceId);
    if (!inv) continue;

    // Hóa đơn đã hủy thì không can thiệp.
    if (inv.status === 2) {
      skipped++;
      continue;
    }

    const target =
      packingDeliveredAt.get(invoiceId) ?? directReportedAt.get(invoiceId);
    if (!target) {
      skipped++;
      continue;
    }
    if (inv.deliveredAt && inv.deliveredAt.getTime() === target.getTime()) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `   [DRY] ${inv.code}: ${inv.deliveredAt?.toISOString() ?? 'null'} → ${target.toISOString()}`,
      );
    } else {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { deliveredAt: target },
      });
    }
    updated++;
  }

  console.log(
    `✅ Xong — ${updated} hóa đơn ${DRY_RUN ? 'sẽ được' : 'đã'} cập nhật, ${skipped} bỏ qua (đã đúng hoặc đã hủy).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
