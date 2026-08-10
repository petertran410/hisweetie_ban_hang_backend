/**
 * Script kiểm chứng dữ liệu — Giai đoạn 0 (Purchasing Planning)
 *
 * MỤC ĐÍCH: trả lời các câu hỏi CHẶN triển khai trước khi viết engine.
 *   OQ-01  Đơn vị số lượng có nhất quán giữa InventoryLog và Inventory không?
 *   OQ-02  InventoryLog có ghi đầy đủ mọi biến động tồn kho không?
 *   +      Phân bố transactionType (đối chiếu PRD §A.3)
 *   +      Phân bố tuổi SKU + tỉ lệ ngày hết hàng (chốt mơ hồ §5.4 vs §15 Case 1)
 *
 * ĐẶC TÍNH: HOÀN TOÀN READ-ONLY. Không ghi, không sửa bất kỳ bảng nào.
 *
 * Cách chạy: npx ts-node prisma/tests/purchasing-planning-data-audit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Phân loại transaction type theo PRD §5.2 / §A.3
const DEMAND_INCLUDED = [
  'SALE_OUT',
  'SALE',
  'INTERNAL_USE',
  'PRODUCTION_OUT',
  'CONSIGNMENT_OUT',
];
const DEMAND_SUBTRACTED = ['RETURN_IN', 'CONSIGNMENT_RETURN_IN'];

function line(char = '─', len = 78) {
  return char.repeat(len);
}

function header(title: string) {
  console.log('\n' + line('═'));
  console.log(`  ${title}`);
  console.log(line('═'));
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return 'null';
  return Number(n).toLocaleString('vi-VN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

async function main() {
  console.log(line('═'));
  console.log('  KIỂM CHỨNG DỮ LIỆU — PURCHASING PLANNING (Giai đoạn 0)');
  console.log(`  Thời điểm: ${new Date().toLocaleString('vi-VN')}`);
  console.log('  Chế độ: READ-ONLY');
  console.log(line('═'));

  // ══════════════════════════════════════════════════════════════════════
  // 0. TỔNG QUAN QUY MÔ
  // ══════════════════════════════════════════════════════════════════════
  header('0. TỔNG QUAN QUY MÔ');

  const [productCount, activeProductCount, invRowCount, logCount, branchCount] =
    await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { isActive: true, allowsSale: true } }),
      prisma.inventory.count(),
      prisma.inventoryLog.count(),
      prisma.branch.count(),
    ]);

  console.log(`  Tổng sản phẩm             : ${fmt(productCount)}`);
  console.log(`  Sản phẩm active + bán được: ${fmt(activeProductCount)}`);
  console.log(`  Dòng tồn kho (product×kho): ${fmt(invRowCount)}`);
  console.log(`  Dòng InventoryLog         : ${fmt(logCount)}`);
  console.log(`  Số chi nhánh              : ${fmt(branchCount)}`);

  if (logCount === 0) {
    console.log('\n  ⛔ InventoryLog RỖNG — không thể forecast. DỪNG.');
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1. PHÂN BỐ TRANSACTION TYPE (đối chiếu PRD §A.3)
  // ══════════════════════════════════════════════════════════════════════
  header('1. PHÂN BỐ TRANSACTION TYPE (90 ngày gần nhất)');

  const since90 = new Date();
  since90.setDate(since90.getDate() - 90);

  const txTypes = await prisma.inventoryLog.groupBy({
    by: ['transactionType'],
    where: { transactionDate: { gte: since90 } },
    _count: { _all: true },
    _sum: { quantity: true },
  });

  txTypes.sort((a, b) => b._count._all - a._count._all);

  console.log(
    '  ' +
      'Transaction Type'.padEnd(26) +
      'Số dòng'.padStart(10) +
      'Tổng SL'.padStart(16) +
      '  Vai trò',
  );
  console.log('  ' + line('─', 74));

  const knownTypes = new Set([...DEMAND_INCLUDED, ...DEMAND_SUBTRACTED]);
  const unknownTypes: string[] = [];

  for (const t of txTypes) {
    const type = t.transactionType;
    let role = 'không tính';
    if (DEMAND_INCLUDED.includes(type)) role = '➕ TÍNH vào demand';
    else if (DEMAND_SUBTRACTED.includes(type)) role = '➖ TRỪ khỏi demand';
    else if (type === 'DESTRUCTION') role = '⚙️  cấu hình (mặc định loại)';

    if (!knownTypes.has(type) && type !== 'DESTRUCTION') {
      unknownTypes.push(type);
    }

    console.log(
      '  ' +
        type.padEnd(26) +
        fmt(t._count._all, 0).padStart(10) +
        fmt(Number(t._sum.quantity ?? 0), 0).padStart(16) +
        '  ' +
        role,
    );
  }

  if (unknownTypes.length > 0) {
    console.log(
      `\n  ⚠️  Type có trong DB nhưng chưa phân loại ở PRD: ${unknownTypes.join(', ')}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. OQ-01 — KIỂM CHỨNG TÍNH NHẤT QUÁN ĐƠN VỊ  ★ QUAN TRỌNG NHẤT
  // ══════════════════════════════════════════════════════════════════════
  header('2. OQ-01 — TÍNH NHẤT QUÁN ĐƠN VỊ  ★ CHẶN DỰ ÁN NẾU SAI');

  console.log('  Nguyên lý: Σ(toàn bộ InventoryLog.quantity) của 1 SKU tại 1 kho');
  console.log('             PHẢI bằng Inventory.onHand (nếu log đầy đủ & cùng đơn vị)\n');

  // Lấy 20 SKU có nhiều giao dịch nhất để kiểm chứng
  const topLogged = await prisma.inventoryLog.groupBy({
    by: ['productId', 'branchId'],
    _count: { _all: true },
    orderBy: { _count: { productId: 'desc' } },
    take: 20,
  });

  console.log(
    '  ' +
      'Mã SKU'.padEnd(14) +
      'Kho'.padEnd(6) +
      'Σ log'.padStart(13) +
      'onHand'.padStart(13) +
      'Lệch'.padStart(13) +
      '  Đánh giá',
  );
  console.log('  ' + line('─', 76));

  let matchCount = 0;
  let mismatchCount = 0;
  const ratios: number[] = [];

  for (const row of topLogged) {
    const [sumLog, inv, product] = await Promise.all([
      prisma.inventoryLog.aggregate({
        where: { productId: row.productId, branchId: row.branchId },
        _sum: { quantity: true },
      }),
      prisma.inventory.findFirst({
        where: { productId: row.productId, branchId: row.branchId },
        select: { onHand: true, productCode: true },
      }),
      prisma.product.findUnique({
        where: { id: row.productId },
        select: { code: true, unit: true, conversionValue: true },
      }),
    ]);

    if (!inv) continue;

    const logTotal = Number(sumLog._sum.quantity ?? 0);
    const onHand = Number(inv.onHand);
    const diff = logTotal - onHand;
    const isMatch = Math.abs(diff) < 0.01;

    if (isMatch) matchCount++;
    else {
      mismatchCount++;
      if (onHand !== 0 && logTotal !== 0) {
        ratios.push(logTotal / onHand);
      }
    }

    const verdict = isMatch
      ? '✅ khớp'
      : Math.abs(diff) < Math.abs(onHand) * 0.05
        ? '🟡 lệch nhỏ'
        : '🔴 LỆCH LỚN';

    console.log(
      '  ' +
        (product?.code ?? `#${row.productId}`).padEnd(14) +
        String(row.branchId).padEnd(6) +
        fmt(logTotal, 0).padStart(13) +
        fmt(onHand, 0).padStart(13) +
        fmt(diff, 0).padStart(13) +
        '  ' +
        verdict,
    );
  }

  const totalChecked = matchCount + mismatchCount;
  console.log('\n  ' + line('─', 76));
  console.log(
    `  Khớp: ${matchCount}/${totalChecked}  ·  Lệch: ${mismatchCount}/${totalChecked}`,
  );

  // Phân tích tỉ lệ lệch — dấu hiệu sai đơn vị là tỉ lệ tập trung quanh 1 số nguyên (20, 25, 40...)
  if (ratios.length > 0) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`  Tỉ lệ (Σlog / onHand) trung vị: ${fmt(median, 3)}`);
    if (median > 5 || median < 0.2) {
      console.log(
        '  🔴 CẢNH BÁO: tỉ lệ lệch xa 1 → NGHI NGỜ SAI ĐƠN VỊ (gói vs thùng)',
      );
    } else {
      console.log(
        '  🟢 Tỉ lệ gần 1 → không có dấu hiệu sai đơn vị theo bội số quy đổi',
      );
    }
  }

  console.log('\n  KẾT LUẬN OQ-01:');
  if (matchCount === totalChecked) {
    console.log('  ✅ ĐẠT — đơn vị nhất quán, log đầy đủ. Tiến hành được.');
  } else if (matchCount / totalChecked >= 0.8) {
    console.log(
      '  🟡 ĐẠT MỘT PHẦN — phần lớn khớp. Lệch có thể do log thiếu (xem OQ-02),',
    );
    console.log('     không nhất thiết do sai đơn vị. Cần xem tỉ lệ trung vị ở trên.');
  } else {
    console.log('  🔴 KHÔNG ĐẠT — cần điều tra trước khi viết engine.');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. OQ-02 — ĐỘ ĐẦY ĐỦ CỦA INVENTORY LOG
  // ══════════════════════════════════════════════════════════════════════
  header('3. OQ-02 — ĐỘ ĐẦY ĐỦ CỦA INVENTORY LOG');

  const invWithStock = await prisma.inventory.count({
    where: { onHand: { gt: 0 } },
  });

  const productIdsWithStock = await prisma.inventory.findMany({
    where: { onHand: { gt: 0 } },
    select: { productId: true },
    distinct: ['productId'],
  });
  const stockProductIds = productIdsWithStock.map((p) => p.productId);

  const productIdsWithLog90 = await prisma.inventoryLog.findMany({
    where: {
      transactionDate: { gte: since90 },
      productId: { in: stockProductIds },
    },
    select: { productId: true },
    distinct: ['productId'],
  });
  const loggedIds = new Set(productIdsWithLog90.map((p) => p.productId));
  const noLogIds = stockProductIds.filter((id) => !loggedIds.has(id));

  console.log(`  Dòng tồn kho có onHand > 0        : ${fmt(invWithStock, 0)}`);
  console.log(`  SKU riêng biệt có tồn kho         : ${fmt(stockProductIds.length, 0)}`);
  console.log(`  SKU có giao dịch trong 90 ngày    : ${fmt(loggedIds.size, 0)}`);
  console.log(`  SKU CÓ tồn nhưng KHÔNG có log 90n : ${fmt(noLogIds.length, 0)}`);

  const pctNoLog =
    stockProductIds.length > 0
      ? (noLogIds.length / stockProductIds.length) * 100
      : 0;
  console.log(`  Tỉ lệ                             : ${fmt(pctNoLog, 1)}%`);

  console.log('\n  KẾT LUẬN OQ-02:');
  if (pctNoLog < 10) {
    console.log('  ✅ ĐẠT — log đầy đủ. Dựng lại lịch sử tồn kho được.');
  } else if (pctNoLog < 30) {
    console.log(
      '  🟡 CHẤP NHẬN ĐƯỢC — một số SKU không giao dịch 90 ngày (hàng chậm/ngừng bán).',
    );
    console.log('     Những SKU này sẽ rơi vào NO_DATA — đúng như thiết kế.');
  } else {
    console.log('  🔴 CẦN XEM XÉT — quá nhiều SKU không có log.');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 4. PHÂN BỐ TUỔI SKU (chốt mơ hồ §5.4 vs §15 Case 1)
  // ══════════════════════════════════════════════════════════════════════
  header('4. PHÂN BỐ TUỔI SKU — ảnh hưởng quy tắc fallback');

  console.log('  Tuổi SKU = số ngày từ giao dịch ĐẦU TIÊN tới hôm nay\n');

  const firstTxRows = await prisma.$queryRaw<
    { product_id: number; first_tx: Date; day_count: bigint }[]
  >`
    SELECT "productId" AS product_id,
           MIN("transactionDate") AS first_tx,
           COUNT(DISTINCT DATE("transactionDate")) AS day_count
    FROM inventory_logs
    GROUP BY "productId"
  `;

  const now = Date.now();
  const buckets = {
    '< 14 ngày (NO_DATA)': 0,
    '14–29 ngày (VERY_LOW)': 0,
    '30–59 ngày (LOW)': 0,
    '60–89 ngày (MEDIUM)': 0,
    '>= 90 ngày (HIGH)': 0,
  };

  for (const r of firstTxRows) {
    const ageDays = Math.floor(
      (now - new Date(r.first_tx).getTime()) / 86400000,
    );
    if (ageDays < 14) buckets['< 14 ngày (NO_DATA)']++;
    else if (ageDays < 30) buckets['14–29 ngày (VERY_LOW)']++;
    else if (ageDays < 60) buckets['30–59 ngày (LOW)']++;
    else if (ageDays < 90) buckets['60–89 ngày (MEDIUM)']++;
    else buckets['>= 90 ngày (HIGH)']++;
  }

  const totalAged = firstTxRows.length;
  console.log('  ' + 'Nhóm tuổi'.padEnd(26) + 'Số SKU'.padStart(10) + 'Tỉ lệ'.padStart(10));
  console.log('  ' + line('─', 46));
  for (const [k, v] of Object.entries(buckets)) {
    const pct = totalAged > 0 ? (v / totalAged) * 100 : 0;
    console.log(
      '  ' + k.padEnd(26) + fmt(v, 0).padStart(10) + (fmt(pct, 1) + '%').padStart(10),
    );
  }
  console.log('  ' + line('─', 46));
  console.log('  ' + 'TỔNG'.padEnd(26) + fmt(totalAged, 0).padStart(10));

  const newSkuCount =
    buckets['< 14 ngày (NO_DATA)'] +
    buckets['14–29 ngày (VERY_LOW)'] +
    buckets['30–59 ngày (LOW)'] +
    buckets['60–89 ngày (MEDIUM)'];
  const pctNew = totalAged > 0 ? (newSkuCount / totalAged) * 100 : 0;
  console.log(
    `\n  → SKU chưa đủ 90 ngày tuổi (bị ảnh hưởng bởi quy tắc fallback): ${fmt(newSkuCount, 0)} (${fmt(pctNew, 1)}%)`,
  );

  // ══════════════════════════════════════════════════════════════════════
  // 5. TỈ LỆ NGÀY CÓ GIAO DỊCH (proxy cho mật độ dữ liệu)
  // ══════════════════════════════════════════════════════════════════════
  header('5. MẬT ĐỘ GIAO DỊCH — proxy cho "ngày có hàng"');

  console.log('  Số ngày CÓ GIAO DỊCH trong 90 ngày gần nhất (theo SKU)');
  console.log('  Lưu ý: đây KHÔNG phải "ngày có hàng" (cần dựng lại tồn kho),');
  console.log('  nhưng cho biết mật độ dữ liệu để ước lượng mẫu số.\n');

  const activeDays = await prisma.$queryRaw<
    { product_id: number; active_days: bigint }[]
  >`
    SELECT "productId" AS product_id,
           COUNT(DISTINCT DATE("transactionDate")) AS active_days
    FROM inventory_logs
    WHERE "transactionDate" >= ${since90}
    GROUP BY "productId"
  `;

  const densityBuckets = {
    '< 14 ngày': 0,
    '14–29 ngày': 0,
    '30–59 ngày': 0,
    '60–90 ngày': 0,
  };
  for (const r of activeDays) {
    const d = Number(r.active_days);
    if (d < 14) densityBuckets['< 14 ngày']++;
    else if (d < 30) densityBuckets['14–29 ngày']++;
    else if (d < 60) densityBuckets['30–59 ngày']++;
    else densityBuckets['60–90 ngày']++;
  }

  console.log('  ' + 'Số ngày có giao dịch'.padEnd(26) + 'Số SKU'.padStart(10) + 'Tỉ lệ'.padStart(10));
  console.log('  ' + line('─', 46));
  const totalActive = activeDays.length;
  for (const [k, v] of Object.entries(densityBuckets)) {
    const pct = totalActive > 0 ? (v / totalActive) * 100 : 0;
    console.log(
      '  ' + k.padEnd(26) + fmt(v, 0).padStart(10) + (fmt(pct, 1) + '%').padStart(10),
    );
  }

  console.log(
    `\n  → SKU có < 14 ngày giao dịch trong 90 ngày: ${fmt(densityBuckets['< 14 ngày'], 0)}`,
  );
  console.log('    (nhóm này rủi ro forecast phóng đại — cần cờ VERY_LOW)');

  // ══════════════════════════════════════════════════════════════════════
  // 6. KIỂM TRA TỒN KHO ÂM
  // ══════════════════════════════════════════════════════════════════════
  header('6. TỒN KHO ÂM (cờ NEGATIVE_INVENTORY)');

  const negativeInv = await prisma.inventory.count({
    where: { onHand: { lt: 0 } },
  });
  console.log(`  Số dòng tồn kho âm: ${fmt(negativeInv, 0)}`);
  if (negativeInv > 0) {
    const samples = await prisma.inventory.findMany({
      where: { onHand: { lt: 0 } },
      select: { productCode: true, productName: true, branchName: true, onHand: true },
      take: 5,
    });
    console.log('  Ví dụ:');
    for (const s of samples) {
      console.log(
        `    ${s.productCode.padEnd(14)} ${String(s.branchName).padEnd(20)} ${fmt(Number(s.onHand), 0)}`,
      );
    }
    console.log('  → Những SKU này sẽ bị BLOCKED theo PRD §15 Case 4');
  } else {
    console.log('  ✅ Không có tồn kho âm');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 7. NGUỒN DỮ LIỆU CHO INCOMING & LEADTIME
  // ══════════════════════════════════════════════════════════════════════
  header('7. NGUỒN DỮ LIỆU INCOMING & LEADTIME');

  const [osConfirmed, osPartial, vsWithEta, vsWithActual] = await Promise.all([
    prisma.orderSupplier.count({ where: { status: 1 } }),
    prisma.orderSupplier.count({ where: { status: 2 } }),
    prisma.vehicleShipment.count({ where: { expectedArrivalDate: { not: null } } }),
    prisma.vehicleShipment.count({ where: { actualArrivalDate: { not: null } } }),
  ]);

  console.log(`  OrderSupplier "Đã xác nhận NCC" (1) : ${fmt(osConfirmed, 0)}`);
  console.log(`  OrderSupplier "Nhập một phần"   (2) : ${fmt(osPartial, 0)}`);
  console.log(`  → Tổng phiếu tính vào Incoming      : ${fmt(osConfirmed + osPartial, 0)}`);
  console.log('');
  console.log(`  VehicleShipment có expectedArrivalDate: ${fmt(vsWithEta, 0)}  (nguồn ETA)`);
  console.log(`  VehicleShipment có actualArrivalDate  : ${fmt(vsWithActual, 0)}  (học leadtime)`);

  if (vsWithActual < 3) {
    console.log('\n  ⚠️  Quá ít dữ liệu giao hàng thực tế → auto-derive leadtime chưa dùng được');
    console.log('     → Phải dựa vào config mặc định theo nhóm hàng');
  } else {
    console.log(`\n  ✅ Đủ mẫu để auto-derive leadtime (>= 3 lô)`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 8. ĐƠN HÀNG CHƯA GIAO (Reserved Stock)
  // ══════════════════════════════════════════════════════════════════════
  header('8. RESERVED STOCK — đơn hàng chưa giao');

  const [orderPending, orderConfirmed] = await Promise.all([
    prisma.order.count({ where: { status: 1 } }),
    prisma.order.count({ where: { status: 5 } }),
  ]);
  console.log(`  Order "Phiếu tạm"    (1): ${fmt(orderPending, 0)}`);
  console.log(`  Order "Đã xác nhận"  (5): ${fmt(orderConfirmed, 0)}`);
  console.log(`  → Tổng đơn tính Reserved: ${fmt(orderPending + orderConfirmed, 0)}`);

  // ══════════════════════════════════════════════════════════════════════
  // TỔNG KẾT
  // ══════════════════════════════════════════════════════════════════════
  header('TỔNG KẾT — SẴN SÀNG TRIỂN KHAI?');

  const oq01Pass = matchCount / Math.max(totalChecked, 1) >= 0.8;
  const oq02Pass = pctNoLog < 30;
  const hasData = logCount > 1000;

  console.log(`  OQ-01 Đơn vị nhất quán        : ${oq01Pass ? '✅ ĐẠT' : '🔴 CẦN XEM XÉT'}`);
  console.log(`  OQ-02 InventoryLog đầy đủ     : ${oq02Pass ? '✅ ĐẠT' : '🔴 CẦN XEM XÉT'}`);
  console.log(`  Đủ dữ liệu để forecast        : ${hasData ? '✅ ĐẠT' : '🔴 THIẾU'}`);
  console.log(`  Nguồn ETA (VehicleShipment)   : ${vsWithEta > 0 ? '✅ CÓ' : '🟡 KHÔNG — dùng ESTIMATED'}`);
  console.log(`  Nguồn học leadtime            : ${vsWithActual >= 3 ? '✅ CÓ' : '🟡 THIẾU — dùng default'}`);

  console.log('\n  ' + line('─', 74));
  if (oq01Pass && oq02Pass && hasData) {
    console.log('  🟢 SẴN SÀNG — có thể tiến hành Giai đoạn 1 (API Contract)');
  } else {
    console.log('  🔴 CHƯA SẴN SÀNG — cần xử lý các mục 🔴 ở trên trước');
  }
  console.log('  ' + line('─', 74));
}

main()
  .catch((e) => {
    console.error('\n⛔ LỖI KHI CHẠY KIỂM CHỨNG:');
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
