/**
 * MIG: Fix Order.status / statusValue / orderStatus bị sai do sync KiotViet cũ
 *
 * Bối cảnh:
 *   `sync-kiot/services/sync-order.service.ts` (cũ) có 2 bug:
 *     1. Block UPDATE ghi nhầm slug ('pending'/'processing'/...) vào `statusValue`
 *        thay vì nhãn TV ("Phiếu tạm"/"Đang giao hàng"/...).
 *     2. Hàm map mapping sai: KiotViet status=2 ("Đang giao hàng") trả slug
 *        'processing', nhưng backend không có trạng thái này → save bị nhảy về
 *        PENDING. KiotViet status=5 ("Đã xác nhận") cũ trả slug 'completed' (sai).
 *
 *   Bug đã được fix trong code. Script này dọn dữ liệu lịch sử.
 *
 *   Mapping chuẩn (theo nghiệp vụ):
 *     status=1 → pending           → "Phiếu tạm"
 *     status=2 → completed (gộp)   → "Hoàn thành"   (KiotViet "Đang giao hàng")
 *     status=3 → completed         → "Hoàn thành"
 *     status=4 → cancelled         → "Đã hủy"
 *     status=5 → confirmed         → "Đã xác nhận"
 *     status=6 → partially_invoiced → "Đã ra 1 phần hóa đơn"
 *
 * Cách chạy:
 *   yarn fix:order-status            # chạy thật
 *   yarn fix:order-status --dry-run  # chỉ in, không update
 *
 * Hiệu năng: dùng updateMany group theo target status, chunk 1000 IDs/query.
 *   Với ~100k rows: ~5 nhóm × ~100 chunk ≈ 500 query → vài chục giây.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SLUG_SET = new Set([
  'pending',
  'processing',
  'completed',
  'cancelled',
  'confirmed',
  'partially_invoiced',
]);

const STATUS_LABELS: Record<number, string> = {
  1: 'Phiếu tạm',
  3: 'Hoàn thành',
  4: 'Đã hủy',
  5: 'Đã xác nhận',
  6: 'Đã ra 1 phần hóa đơn',
};

const STATUS_TO_SLUG: Record<number, string> = {
  1: 'pending',
  3: 'completed',
  4: 'cancelled',
  5: 'confirmed',
  6: 'partially_invoiced',
};

const TARGET_BY_STATUS: Record<
  number,
  { status: number; statusValue: string; orderStatus: string }
> = {
  1: { status: 1, statusValue: 'Phiếu tạm', orderStatus: 'pending' },
  3: { status: 3, statusValue: 'Hoàn thành', orderStatus: 'completed' },
  4: { status: 4, statusValue: 'Đã hủy', orderStatus: 'cancelled' },
  5: { status: 5, statusValue: 'Đã xác nhận', orderStatus: 'confirmed' },
  6: {
    status: 6,
    statusValue: 'Đã ra 1 phần hóa đơn',
    orderStatus: 'partially_invoiced',
  },
};

const CHUNK_SIZE = 1000;

function mapLegacyStatus(status: number | null | undefined): number {
  if (status == null) return 1;
  // KiotViet status=2 ("Đang giao hàng") gộp về 3 ("Hoàn thành")
  if (status === 2) return 3;
  // status hợp lệ trong hệ thống mới: 1, 3, 4, 5, 6
  if (![1, 3, 4, 5, 6].includes(status)) return 1;
  return status;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    `Bắt đầu migration order status${dryRun ? ' (--dry-run)' : ''}...\n`,
  );

  const allOrders = await prisma.order.findMany({
    select: {
      id: true,
      code: true,
      status: true,
      statusValue: true,
      orderStatus: true,
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Tổng số Order trong DB: ${allOrders.length}\n`);

  let countSlugStatusValue = 0;
  let countLegacyStatus2 = 0;
  let countOrderStatusMismatch = 0;
  let countNoChange = 0;

  // Group ids theo target status để dùng updateMany
  const idsByTargetStatus: Record<number, number[]> = {
    1: [],
    3: [],
    4: [],
    5: [],
    6: [],
  };

  // Giữ preview cho 30 dòng đầu
  const previewLines: string[] = [];

  for (const order of allOrders) {
    const reasons: string[] = [];
    const newStatus = mapLegacyStatus(order.status);
    if (newStatus !== order.status) {
      reasons.push(`status ${order.status} → ${newStatus}`);
      countLegacyStatus2++;
    }

    const expectedLabel = STATUS_LABELS[newStatus] ?? 'Phiếu tạm';
    const expectedSlug = STATUS_TO_SLUG[newStatus] ?? 'pending';

    const currentValueLower = (order.statusValue ?? '').toLowerCase().trim();

    let needStatusValueUpdate = false;
    if (
      order.statusValue == null ||
      SLUG_SET.has(currentValueLower) ||
      newStatus !== order.status
    ) {
      if (order.statusValue !== expectedLabel) {
        if (SLUG_SET.has(currentValueLower)) {
          reasons.push(
            `statusValue '${order.statusValue}' → '${expectedLabel}'`,
          );
          countSlugStatusValue++;
        } else {
          reasons.push(
            `statusValue '${order.statusValue ?? '(null)'}' → '${expectedLabel}'`,
          );
        }
        needStatusValueUpdate = true;
      }
    } else if (order.statusValue !== expectedLabel) {
      // Edge case: statusValue đã là text TV nhưng không khớp với label đúng
      // (vd KiotViet trả "Đã giao" mà ta map về "Hoàn thành"). Giữ nguyên,
      // không cập nhật để tránh ghi đè text mà người dùng có thể đã chỉnh tay.
    }

    let needOrderStatusUpdate = false;
    if (order.orderStatus !== expectedSlug) {
      reasons.push(`orderStatus '${order.orderStatus}' → '${expectedSlug}'`);
      countOrderStatusMismatch++;
      needOrderStatusUpdate = true;
    }

    const needStatusUpdate = newStatus !== order.status;

    if (
      !needStatusUpdate &&
      !needStatusValueUpdate &&
      !needOrderStatusUpdate
    ) {
      countNoChange++;
      continue;
    }

    idsByTargetStatus[newStatus].push(order.id);

    if (previewLines.length < 30) {
      previewLines.push(`  [${order.code}] ${reasons.join('; ')}`);
    }
  }

  const totalToUpdate = Object.values(idsByTargetStatus).reduce(
    (sum, ids) => sum + ids.length,
    0,
  );

  console.log(`Thống kê:`);
  console.log(
    `  - statusValue là slug (cần đổi sang nhãn TV): ${countSlugStatusValue}`,
  );
  console.log(
    `  - status=2 cần map về status=3 (Hoàn thành): ${countLegacyStatus2}`,
  );
  console.log(
    `  - orderStatus lệch với status:               ${countOrderStatusMismatch}`,
  );
  console.log(
    `  - Order không cần update:                    ${countNoChange}`,
  );
  console.log(
    `  - Tổng số Order sẽ update:                   ${totalToUpdate}\n`,
  );

  if (totalToUpdate === 0) {
    console.log('Không có gì để fix. Thoát.');
    return;
  }

  console.log(`Phân bổ theo target status:`);
  for (const status of [1, 3, 4, 5, 6] as const) {
    const ids = idsByTargetStatus[status];
    if (ids.length > 0) {
      const target = TARGET_BY_STATUS[status];
      console.log(
        `  - status=${status} ('${target.statusValue}'): ${ids.length}`,
      );
    }
  }
  console.log('');

  console.log(`Preview ${previewLines.length}/${totalToUpdate} bản ghi đầu tiên:`);
  for (const line of previewLines) {
    console.log(line);
  }
  if (totalToUpdate > previewLines.length) {
    console.log(`  ... (${totalToUpdate - previewLines.length} dòng nữa)`);
  }

  if (dryRun) {
    console.log('\n--dry-run: KHÔNG update DB. Bỏ flag để chạy thật.');
    return;
  }

  console.log('\nBắt đầu update (updateMany theo nhóm status)...');
  const startTime = Date.now();
  let totalDone = 0;

  for (const status of [1, 3, 4, 5, 6] as const) {
    const ids = idsByTargetStatus[status];
    if (ids.length === 0) continue;

    const target = TARGET_BY_STATUS[status];
    let groupDone = 0;

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const result = await prisma.order.updateMany({
        where: { id: { in: chunk } },
        data: {
          status: target.status,
          statusValue: target.statusValue,
          orderStatus: target.orderStatus,
        },
      });
      groupDone += result.count;
      totalDone += result.count;
    }

    console.log(
      `  ✓ status=${status} ('${target.statusValue}'): updated ${groupDone}/${ids.length}`,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✓ Đã update ${totalDone}/${totalToUpdate} Order trong ${elapsed}s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
