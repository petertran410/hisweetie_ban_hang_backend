/**
 * Backfill cho Wave 2 NCC:
 *
 * 1. Match `PurchaseOrderPayment.cashFlowId` cho records cũ — tìm CashFlow
 *    có code trùng với payment.code, link FK lại.
 * 2. Match `OrderSupplierPayment.cashFlowId` tương tự.
 * 3. Backfill `CashFlow.supplierDebtSnapshot` cho mọi cashflow `partnerType='S'`
 *    bằng cumulative running debt theo Formula B (giống cách FE đang dùng
 *    running sum để hiển thị timeline). Snapshot giá trị TẠI THỜI ĐIỂM cashflow
 *    được tạo, chứ KHÔNG phải debt cuối cùng — đây là pattern mirror
 *    `customerDebtSnapshot` của phía bán (mỗi cashflow = "snapshot debt sau
 *    transaction này").
 *
 * Cách chạy:
 *   yarn ts-node prisma/seeds/backfill-supplier-debt-snapshot.ts            # chạy thật
 *   yarn ts-node prisma/seeds/backfill-supplier-debt-snapshot.ts --dry-run  # chỉ in
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SupplierTimelineRow {
  id: number;
  type: 'po' | 'cf_in' | 'cf_out' | 'sr_offset';
  time: Date;
  amount: number; // signed delta to debt
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Wave 2 backfill (NCC)');
  console.log(`  Mode: ${dryRun ? '[DRY-RUN]' : '[REAL RUN]'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ─── PHASE 1: backfill PurchaseOrderPayment.cashFlowId ────────────────────
  console.log('PHASE 1: Backfill PurchaseOrderPayment.cashFlowId');
  console.log('---------------------------------------------------------------');

  const orphanPOPayments = await prisma.purchaseOrderPayment.findMany({
    where: { cashFlowId: null },
    select: { id: true, code: true },
  });
  console.log(`  Found ${orphanPOPayments.length} PurchaseOrderPayment chưa có cashFlowId`);

  let poLinked = 0;
  let poNotFound = 0;
  for (const p of orphanPOPayments) {
    if (!p.code) {
      poNotFound++;
      continue;
    }
    const cf = await prisma.cashFlow.findFirst({
      where: { code: p.code, partnerType: 'S' },
      select: { id: true },
    });
    if (!cf) {
      poNotFound++;
      continue;
    }
    if (!dryRun) {
      await prisma.purchaseOrderPayment.update({
        where: { id: p.id },
        data: { cashFlowId: cf.id },
      });
    }
    poLinked++;
  }
  console.log(`  ✓ Linked: ${poLinked}`);
  console.log(`  ✗ Không tìm thấy CashFlow trùng code: ${poNotFound}\n`);

  // ─── PHASE 2: backfill OrderSupplierPayment.cashFlowId ────────────────────
  console.log('PHASE 2: Backfill OrderSupplierPayment.cashFlowId');
  console.log('---------------------------------------------------------------');

  const orphanOSPayments = await prisma.orderSupplierPayment.findMany({
    where: { cashFlowId: null },
    select: { id: true, code: true },
  });
  console.log(`  Found ${orphanOSPayments.length} OrderSupplierPayment chưa có cashFlowId`);

  let osLinked = 0;
  let osNotFound = 0;
  for (const p of orphanOSPayments) {
    if (!p.code) {
      osNotFound++;
      continue;
    }
    const cf = await prisma.cashFlow.findFirst({
      where: { code: p.code, partnerType: 'S' },
      select: { id: true },
    });
    if (!cf) {
      osNotFound++;
      continue;
    }
    if (!dryRun) {
      await prisma.orderSupplierPayment.update({
        where: { id: p.id },
        data: { cashFlowId: cf.id },
      });
    }
    osLinked++;
  }
  console.log(`  ✓ Linked: ${osLinked}`);
  console.log(`  ✗ Không tìm thấy CashFlow trùng code: ${osNotFound}\n`);

  // ─── PHASE 3: backfill CashFlow.supplierDebtSnapshot ──────────────────────
  console.log('PHASE 3: Backfill CashFlow.supplierDebtSnapshot');
  console.log('---------------------------------------------------------------');

  const suppliers = await prisma.supplier.findMany({
    select: { id: true, code: true, name: true },
  });
  console.log(`  Found ${suppliers.length} suppliers\n`);

  let cfUpdated = 0;
  let cfSkipped = 0;

  for (const s of suppliers) {
    // Build timeline theo Formula B:
    //   debt += PO.subTotal   (POs tạo ngày X — coi là debt tăng tại ngày đó)
    //   debt += CashFlow.amount khi isReceipt=true (NCC ứng cho mình)
    //   debt -= CashFlow.amount khi isReceipt=false (mình trả NCC)
    //   debt -= SupplierReturn.refundAmount khi status=2 hoặc (status=3 + refundType in ['cash_refund','debt_offset'])
    //
    // Filter: cùng filter của recalcSupplierDebt — KHÔNG cộng cashflow PCTUPN.

    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: { supplierId: s.id, isDraft: false },
      select: { total: true, discount: true, createdAt: true, code: true },
      orderBy: { createdAt: 'asc' },
    });

    const cashFlows = await prisma.cashFlow.findMany({
      where: {
        partnerType: 'S',
        partnerId: s.id,
        status: { not: 2 },
      },
      select: {
        id: true,
        code: true,
        isReceipt: true,
        amount: true,
        transDate: true,
      },
      orderBy: [{ transDate: 'asc' }, { id: 'asc' }],
    });

    const supplierReturns = await prisma.supplierReturn.findMany({
      where: {
        supplierId: s.id,
        OR: [
          { status: 2 },
          { status: 3, refundType: 'cash_refund' },
          { status: 3, refundType: 'debt_offset' },
        ],
      },
      select: {
        id: true,
        refundAmount: true,
        createdAt: true,
        refundConfirmedAt: true,
        exportedAt: true,
        status: true,
      },
    });

    // Gộp thành timeline. Mỗi sự kiện làm thay đổi debt:
    type Event = { time: Date; delta: number; cashFlowId?: number; isPctupn?: boolean };
    const events: Event[] = [];

    for (const po of purchaseOrders) {
      events.push({
        time: po.createdAt,
        delta: Number(po.total) - Number(po.discount),
      });
    }

    for (const cf of cashFlows) {
      const isPctupn = cf.code?.startsWith('PCTUPN') ?? false;
      // Theo Formula B đã tính: cashFlowsPaid filter NOT startsWith PCTUPN
      // → PCTUPN không tham gia tính debt thực tế. Khi build snapshot, vẫn
      // cần đặt snapshot vào CashFlow PCTUPN (giá trị tại thời điểm tạo)
      // nhưng KHÔNG để PCTUPN ảnh hưởng running debt.
      const delta = isPctupn
        ? 0
        : cf.isReceipt
          ? Number(cf.amount) // thu (NCC ứng) → +debt
          : -Number(cf.amount); // chi (mình trả) → -debt
      events.push({
        time: cf.transDate,
        delta,
        cashFlowId: cf.id,
        isPctupn,
      });
    }

    for (const sr of supplierReturns) {
      const time =
        sr.status === 3
          ? sr.refundConfirmedAt || sr.createdAt
          : sr.exportedAt || sr.createdAt;
      events.push({
        time,
        delta: -Number(sr.refundAmount),
      });
    }

    // Sort theo thời gian — đối xứng cách `getSupplierDebtTimeline` lấy data.
    events.sort((a, b) => a.time.getTime() - b.time.getTime());

    let runningDebt = 0;
    for (const ev of events) {
      runningDebt += ev.delta;
      if (ev.cashFlowId !== undefined) {
        if (!dryRun) {
          await prisma.cashFlow.update({
            where: { id: ev.cashFlowId },
            data: { supplierDebtSnapshot: runningDebt },
          });
        }
        cfUpdated++;
      }
    }
  }

  console.log(`  ✓ Updated: ${cfUpdated} cashflow`);
  console.log(`  ⊘ Skipped: ${cfSkipped}\n`);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Hoàn tất ${dryRun ? '[DRY-RUN]' : ''}.`);
  console.log(`  PurchaseOrderPayment linked: ${poLinked}`);
  console.log(`  OrderSupplierPayment linked: ${osLinked}`);
  console.log(`  CashFlow snapshot updated: ${cfUpdated}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
