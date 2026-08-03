// prisma/seeds/reset-condition-opening-to-clt.ts
//
// MỤC ĐÍCH
// Dọn sạch dữ liệu loại tồn hiện có rồi khai báo lại bằng PHIẾU CLT hoàn chỉnh:
//
//   1. Chụp (snapshot) toàn bộ dòng OPENING đang có -> ghi file JSON sao lưu.
//   2. Xóa TẤT CẢ StockConditionLog + toàn bộ phiếu CLT cũ (kèm details).
//   3. Tạo lại phiếu CLT status=2 (Đã duyệt), TÁCH RIÊNG theo (chi nhánh, loại tồn),
//      mỗi phiếu ghi lại đúng số lượng từ snapshot OPENING.
//   4. Ghi sổ cái CLT_IN cho từng dòng phiếu, rồi recalc cache 3 bucket.
//
// VÌ SAO GỘP 1 SCRIPT: sau khi xóa thì OPENING không còn, không có nguồn nào để
// tạo phiếu nữa. Toàn bộ chạy trong 1 transaction — lỗi ở bất kỳ bước nào thì
// rollback về nguyên trạng.
//
// AN TOÀN
//   - KHÔNG đụng Inventory.onHand, KHÔNG đụng hóa đơn, KHÔNG đụng InventoryLog.
//   - Chỉ ghi 3 cột cache bucket (damagedQuantity/nearExpiryQuantity/promoQuantity)
//     bằng số dẫn xuất từ sổ cái mới.
//   - Mặc định CHẠY THỬ (dry-run): in ra bảng đối chiếu, không ghi gì.
//
// CÁCH CHẠY
//   Chạy thử:  npx ts-node prisma/seeds/reset-condition-opening-to-clt.ts
//   Chạy thật: npx ts-node prisma/seeds/reset-condition-opening-to-clt.ts --apply
//   Đổi ngày phiếu: thêm --date=2026-07-29   (mặc định: hôm nay)

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const dateArg = process.argv.find((a) => a.startsWith('--date='));
const TRANSFER_DATE = dateArg
  ? new Date(`${dateArg.split('=')[1]}T00:00:00.000Z`)
  : new Date();

const BUCKET_LABEL: Record<string, string> = {
  DAMAGED: 'Bục rách (loại B)',
  NEAR_EXPIRY: 'Cận date',
  PROMO: 'Khuyến mãi',
};

// Thứ tự tạo phiếu cho dễ đọc: mỗi chi nhánh lần lượt Bục rách -> Cận date -> KM.
const BUCKET_ORDER = ['DAMAGED', 'NEAR_EXPIRY', 'PROMO'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// GHI ĐÈ SỐ LƯỢNG KHAI BÁO
//
// Số trong dòng OPENING được backfill chụp từ cột cache Inventory ngày 22/07.
// Có 2 cặp mà số chụp đó KHÔNG phản ánh tồn thật, đã đối chiếu và người dùng
// xác nhận số đúng. Ghi đè tại đây để phiếu khai báo đúng thực tế, kèm lý do
// lưu vào cột note của dòng phiếu để sau tra lại được.
//
// Đặt quantity = 0 thì dòng đó bị loại khỏi phiếu (không khai báo).
// Key: `${productCode}|${branchId}|${bucket}`
// ─────────────────────────────────────────────────────────────────────────────
const QUANTITY_OVERRIDES: Record<
  string,
  { quantity: number; reason: string }
> = {
  'SP000740|6|PROMO': {
    quantity: 97,
    reason:
      'Backfill chụp 85 lúc HD112408 còn hiệu lực (đã trừ 12 quà tặng). HD112408 hủy ngày 24/07 nên 12 cái đã về lại kho KM, số đúng là 97.',
  },
  'SP007528|6|PROMO': {
    quantity: 0,
    reason:
      'Phân bổ 450 từ phiếu KKM000007 chưa từng xuất quà tặng nào (0 dòng gift trên hóa đơn còn hiệu lực); hàng đã bán hết dưới dạng bán thường. Không còn hàng dành riêng cho KM.',
  },
};

interface OpeningRow {
  productId: number;
  productCode: string;
  productName: string;
  branchId: number;
  bucket: string;
  quantity: number;
  expiryDate: Date | null;
  costPrice: number;
  /** Lý do ghi đè (nếu có) — ghi vào note của dòng phiếu. */
  overrideReason?: string;
  /** Số gốc trong OPENING trước khi ghi đè — chỉ để in đối chiếu. */
  originalQuantity?: number;
}

async function main() {
  console.log(
    APPLY
      ? '⚠️  CHẾ ĐỘ GHI THẬT (--apply). Mọi thay đổi nằm trong 1 transaction.'
      : '🔍 CHẠY THỬ (dry-run). Không ghi gì vào DB. Thêm --apply để ghi thật.',
  );
  console.log(
    `📅 Ngày phiếu khai báo: ${TRANSFER_DATE.toISOString().slice(0, 10)}\n`,
  );

  // ── 1. Chụp dữ liệu OPENING ──────────────────────────────────────────────
  const openingLogs = await prisma.stockConditionLog.findMany({
    where: { transactionType: 'OPENING' },
    orderBy: [{ branchId: 'asc' }, { bucket: 'asc' }, { productCode: 'asc' }],
  });

  if (openingLogs.length === 0) {
    console.log('❌ Không tìm thấy dòng OPENING nào. Dừng lại để tránh xóa oan.');
    return;
  }

  // Áp bảng ghi đè ngay khi chụp: dòng có quantity=0 sau ghi đè bị loại khỏi phiếu.
  const appliedOverrides: Array<{
    key: string;
    from: number;
    to: number;
    reason: string;
  }> = [];

  const opening: OpeningRow[] = openingLogs
    .map((l) => {
      const original = Number(l.quantity);
      const key = `${l.productCode}|${l.branchId}|${l.bucket}`;
      const ov = QUANTITY_OVERRIDES[key];
      if (ov && ov.quantity !== original) {
        appliedOverrides.push({
          key,
          from: original,
          to: ov.quantity,
          reason: ov.reason,
        });
      }
      return {
        productId: l.productId,
        productCode: l.productCode,
        productName: l.productName,
        branchId: l.branchId,
        bucket: l.bucket,
        quantity: ov ? ov.quantity : original,
        expiryDate: l.expiryDate,
        costPrice: Number(l.costPrice),
        overrideReason: ov ? ov.reason : undefined,
        originalQuantity: ov ? original : undefined,
      };
    })
    // Loại dòng khai báo 0 (không còn tồn loại đó) — không tạo dòng phiếu rỗng.
    .filter((r) => r.quantity !== 0);

  if (appliedOverrides.length > 0) {
    console.log('─── GHI ĐÈ SỐ LƯỢNG (đã xác nhận) ───');
    for (const o of appliedOverrides) {
      console.log(`${o.key}: ${o.from} → ${o.to}`);
      console.log(`   lý do: ${o.reason}`);
    }
    console.log('');
  }

  // Tên chi nhánh lấy từ bảng Branch (branchName trong log cũ có thể sai).
  const branchIds = [...new Set(opening.map((r) => r.branchId))];
  const branches = await prisma.branch.findMany({
    where: { id: { in: branchIds } },
    select: { id: true, name: true },
  });
  const branchNameMap = new Map(branches.map((b) => [b.id, b.name]));

  // ── 2. Thống kê những gì sẽ bị xóa ───────────────────────────────────────
  const totalLogs = await prisma.stockConditionLog.count();
  const logsByType = await prisma.stockConditionLog.groupBy({
    by: ['transactionType'],
    _count: { _all: true },
  });
  const oldTransfers = await prisma.stockConditionTransfer.findMany({
    select: { id: true, code: true, status: true },
    orderBy: { id: 'asc' },
  });
  const oldDetailCount = await prisma.stockConditionTransferDetail.count();

  console.log('─── SẼ XÓA ───');
  console.log(`StockConditionLog: ${totalLogs} dòng`);
  logsByType.forEach((g) =>
    console.log(`   • ${g.transactionType}: ${g._count._all}`),
  );
  console.log(
    `Phiếu CLT: ${oldTransfers.length} phiếu (${oldTransfers.map((t) => t.code).join(', ') || 'không có'}), ${oldDetailCount} dòng chi tiết\n`,
  );

  // ── 3. Gom phiếu mới theo (chi nhánh, loại tồn) ──────────────────────────
  const groups = new Map<string, OpeningRow[]>();
  for (const row of opening) {
    const key = `${row.branchId}|${row.bucket}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Sắp xếp: chi nhánh tăng dần, trong mỗi chi nhánh theo BUCKET_ORDER.
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const [ba, bka] = a.split('|');
    const [bb, bkb] = b.split('|');
    if (ba !== bb) return Number(ba) - Number(bb);
    return (
      BUCKET_ORDER.indexOf(bka as any) - BUCKET_ORDER.indexOf(bkb as any)
    );
  });

  console.log('─── SẼ TẠO ───');
  let seq = 0;
  const plan = orderedKeys.map((key) => {
    const [branchIdStr, bucket] = key.split('|');
    const branchId = Number(branchIdStr);
    const rows = groups.get(key)!;
    seq += 1;
    const code = `CLT${String(seq).padStart(6, '0')}`;
    const branchName = branchNameMap.get(branchId) || `Chi nhánh ${branchId}`;
    const total = rows.reduce((s, r) => s + r.quantity, 0);
    console.log(
      `${code} | ${branchName} | ${BUCKET_LABEL[bucket]} | ${rows.length} SP | tổng ${total.toLocaleString('vi-VN')}`,
    );
    rows.forEach((r) =>
      console.log(
        `        ${r.productCode.padEnd(12)} ${String(r.quantity).padStart(6)}${
          bucket === 'NEAR_EXPIRY'
            ? `  NSX: ${r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : 'chưa xác định'}`
            : ''
        }${
          r.originalQuantity != null
            ? `  [ghi đè, gốc ${r.originalQuantity}]`
            : ''
        }`,
      ),
    );
    return { code, branchId, branchName, bucket, rows };
  });

  // ── 4. Đối chiếu cache trước / sau ───────────────────────────────────────
  const pairKeys = new Set(opening.map((r) => `${r.productId}|${r.branchId}`));
  const invBefore = await prisma.inventory.findMany({
    where: {
      OR: [...pairKeys].map((k) => {
        const [pid, bid] = k.split('|');
        return { productId: Number(pid), branchId: Number(bid) };
      }),
    },
    select: {
      productId: true,
      productCode: true,
      branchId: true,
      onHand: true,
      damagedQuantity: true,
      nearExpiryQuantity: true,
      promoQuantity: true,
    },
    orderBy: [{ branchId: 'asc' }, { productCode: 'asc' }],
  });

  // Số sau khi khai báo lại = tổng OPENING theo (SP, CN, bucket).
  const afterMap = new Map<string, { d: number; ne: number; p: number }>();
  for (const r of opening) {
    const k = `${r.productId}|${r.branchId}`;
    if (!afterMap.has(k)) afterMap.set(k, { d: 0, ne: 0, p: 0 });
    const t = afterMap.get(k)!;
    if (r.bucket === 'DAMAGED') t.d += r.quantity;
    else if (r.bucket === 'NEAR_EXPIRY') t.ne += r.quantity;
    else if (r.bucket === 'PROMO') t.p += r.quantity;
  }

  console.log('\n─── ĐỐI CHIẾU CACHE (trước → sau) ───');
  console.log(
    'SP           CN   Bục rách        Cận date        Khuyến mãi',
  );
  let diffCount = 0;
  for (const inv of invBefore) {
    const k = `${inv.productId}|${inv.branchId}`;
    const a = afterMap.get(k) || { d: 0, ne: 0, p: 0 };
    const bD = Number(inv.damagedQuantity);
    const bNE = Number(inv.nearExpiryQuantity);
    const bP = Number(inv.promoQuantity);
    const changed = bD !== a.d || bNE !== a.ne || bP !== a.p;
    if (changed) diffCount++;
    const cell = (before: number, after: number) =>
      `${before} → ${after}${before !== after ? ' *' : ''}`.padEnd(16);
    console.log(
      `${inv.productCode.padEnd(12)} ${String(inv.branchId).padEnd(4)} ${cell(bD, a.d)}${cell(bNE, a.ne)}${cell(bP, a.p)}`,
    );
  }
  console.log(
    `\n${diffCount} cặp (SP, chi nhánh) có thay đổi — dấu * là ô lệch.`,
  );

  // ── 5. Ghi file sao lưu ──────────────────────────────────────────────────
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `condition-reset-${stamp}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        mode: APPLY ? 'apply' : 'dry-run',
        transferDate: TRANSFER_DATE.toISOString(),
        allLogs: await prisma.stockConditionLog.findMany(),
        transfers: await prisma.stockConditionTransfer.findMany({
          include: { details: true },
        }),
        inventoryBuckets: invBefore,
        plan: plan.map((p) => ({
          code: p.code,
          branchId: p.branchId,
          branchName: p.branchName,
          bucket: p.bucket,
          rows: p.rows,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n💾 Đã ghi sao lưu: ${backupFile}`);

  if (!APPLY) {
    console.log(
      '\n✅ Chạy thử xong, DB chưa thay đổi. Kiểm tra bảng trên rồi chạy lại với --apply.',
    );
    return;
  }

  // ── 6. Ghi thật (1 transaction) ──────────────────────────────────────────
  console.log('\n⏳ Đang ghi...');
  await prisma.$transaction(
    async (tx) => {
      // Xóa sạch sổ cái + phiếu cũ.
      const delLogs = await tx.stockConditionLog.deleteMany({});
      const delDetails = await tx.stockConditionTransferDetail.deleteMany({});
      const delTransfers = await tx.stockConditionTransfer.deleteMany({});
      console.log(
        `   Đã xóa: ${delLogs.count} log, ${delDetails.count} chi tiết, ${delTransfers.count} phiếu`,
      );

      // Tồn onHand hiện tại để chụp vào currentOnHand của từng dòng phiếu.
      const invAll = await tx.inventory.findMany({
        where: {
          OR: [...pairKeys].map((k) => {
            const [pid, bid] = k.split('|');
            return { productId: Number(pid), branchId: Number(bid) };
          }),
        },
        select: { productId: true, branchId: true, onHand: true, cost: true },
      });
      const invLookup = new Map(
        invAll.map((i) => [`${i.productId}|${i.branchId}`, i]),
      );

      const units = await tx.product.findMany({
        where: { id: { in: [...new Set(opening.map((r) => r.productId))] } },
        select: { id: true, unit: true },
      });
      const unitMap = new Map(units.map((u) => [u.id, u.unit]));

      // Tạo từng phiếu + chi tiết + log CLT_IN.
      for (const p of plan) {
        const transfer = await tx.stockConditionTransfer.create({
          data: {
            code: p.code,
            branchId: p.branchId,
            branchName: p.branchName,
            status: 2, // Đã duyệt — bắt buộc, vì active-finder 'clt' chỉ nhận status=2
            transferDate: TRANSFER_DATE,
            note: `Khai báo tồn ${BUCKET_LABEL[p.bucket]} đầu kỳ`,
            createdById: 1,
            createdByName: 'Admin',
            approvedById: 1,
            approvedByName: 'Admin',
            approvedAt: TRANSFER_DATE,
          },
        });

        for (const r of p.rows) {
          const inv = invLookup.get(`${r.productId}|${r.branchId}`);
          await tx.stockConditionTransferDetail.create({
            data: {
              transferId: transfer.id,
              productId: r.productId,
              productCode: r.productCode,
              productName: r.productName,
              unit: unitMap.get(r.productId) || null,
              toBucket: r.bucket,
              direction: 'IN',
              quantity: r.quantity,
              expiryDate: r.expiryDate,
              currentOnHand: inv ? Number(inv.onHand) : 0,
              costAtTransfer: r.costPrice,
              // Dòng bị ghi đè: lưu lý do + số gốc để sau tra lại được vì sao lệch.
              note: r.overrideReason
                ? `[Điều chỉnh khi khai báo: ${r.originalQuantity} → ${r.quantity}] ${r.overrideReason}`
                : null,
            },
          });

          await tx.stockConditionLog.create({
            data: {
              productId: r.productId,
              productCode: r.productCode,
              productName: r.productName,
              branchId: r.branchId,
              branchName: p.branchName,
              bucket: r.bucket,
              transactionType: 'CLT_IN',
              refCode: p.code,
              refType: 'clt',
              refId: transfer.id,
              quantity: r.quantity,
              expiryDate: r.expiryDate,
              costPrice: r.costPrice,
              transactionDate: TRANSFER_DATE,
              note: r.overrideReason
                ? `Chuyển sang ${BUCKET_LABEL[r.bucket]} (điều chỉnh khi khai báo: ${r.originalQuantity} → ${r.quantity})`
                : `Chuyển sang ${BUCKET_LABEL[r.bucket]}`,
              createdByName: 'Admin',
            },
          });
        }
        console.log(`   ✓ ${p.code} (${p.rows.length} dòng)`);
      }

      // Recalc cache bucket từ sổ cái mới cho mọi cặp liên quan.
      for (const k of pairKeys) {
        const [pid, bid] = k.split('|').map(Number);
        const logs = await tx.stockConditionLog.findMany({
          where: { productId: pid, branchId: bid },
          select: { quantity: true, bucket: true },
        });
        const t = { d: 0, ne: 0, p: 0 };
        for (const l of logs) {
          const q = Number(l.quantity);
          if (l.bucket === 'DAMAGED') t.d += q;
          else if (l.bucket === 'NEAR_EXPIRY') t.ne += q;
          else if (l.bucket === 'PROMO') t.p += q;
        }
        await tx.inventory.updateMany({
          where: { productId: pid, branchId: bid },
          data: {
            damagedQuantity: t.d,
            nearExpiryQuantity: t.ne,
            promoQuantity: t.p,
          },
        });
      }
      console.log(`   ✓ Recalc cache cho ${pairKeys.size} cặp (SP, chi nhánh)`);
    },
    { timeout: 120000 },
  );

  console.log('\n✅ Hoàn tất.');
  console.log('👉 Mở tab "Chuyển loại tồn" và "Thẻ kho loại tồn" để xác nhận.');
}

main()
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
