/**
 * Reconcile Inventory.onHand = Σ log ACTIVE trên thẻ kho (NGUỒN CHÂN LÝ).
 *
 * Bối cảnh: onHand giờ là giá trị DẪN XUẤT từ thẻ kho (giống recalcCustomerDebt
 * với công nợ). Code mới tự reconcile onHand sau mỗi thao tác kiểm kho, nhưng
 * dữ liệu CŨ tạo trước đó vẫn lệch (onHand chứa "tồn ảo" do tạo SP/sync/import
 * không ghi log, hoặc trôi lệch qua các vòng thao tác trước khi sửa logic).
 *
 * Script này set lại onHand = Σ quantity các log thuộc chứng từ CÒN HIỆU LỰC
 * (không bị hủy/xóa) cho từng (productId, branchId) — khớp đúng "Tồn cuối" của
 * giao dịch mới nhất trên thẻ kho.
 *
 * ⚠️ HỆ QUẢ: sản phẩm có tồn đến từ sync KiotViet / import / tạo SP mà CHƯA
 * từng ghi InventoryLog sẽ bị đưa về theo Σ log (có thể về 0). Đây là đúng theo
 * yêu cầu "onHand phải bằng tồn cuối thẻ kho". Cân nhắc kỹ trước khi chạy toàn
 * bộ trên DB thật.
 *
 * Cách chạy:
 *   # Chỉ 1 sản phẩm (an toàn để test):
 *   yarn ts-node prisma/seeds/reconcile-inventory-onhand.ts --product=SP007485 --dry-run
 *   yarn ts-node prisma/seeds/reconcile-inventory-onhand.ts --product=SP007485
 *
 *   # Toàn bộ (xem trước rồi mới chạy thật):
 *   yarn ts-node prisma/seeds/reconcile-inventory-onhand.ts --dry-run
 *   yarn ts-node prisma/seeds/reconcile-inventory-onhand.ts
 */

import { PrismaClient } from '@prisma/client';
import { computeOnHandFromLogs } from '../../src/common/inventory-onhand.util';

const prisma = new PrismaClient();

function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const productCode = getArg('product');

  let productId: number | undefined;
  if (productCode) {
    const p = await prisma.product.findFirst({
      where: { code: productCode },
      select: { id: true },
    });
    if (!p) {
      console.log(`Không tìm thấy sản phẩm ${productCode}`);
      return;
    }
    productId = p.id;
  }

  const inventories = await prisma.inventory.findMany({
    where: productId ? { productId } : {},
    select: {
      id: true,
      productId: true,
      productCode: true,
      branchId: true,
      branchName: true,
      onHand: true,
      product: { select: { weight: true } },
    },
  });

  let changed = 0;
  for (const inv of inventories) {
    const correct = await computeOnHandFromLogs(
      prisma,
      inv.productId,
      inv.branchId,
    );
    const current = Number(inv.onHand);
    if (correct === current) continue;
    changed++;
    console.log(
      `${(inv.productCode || '').padEnd(12)} br${inv.branchId} ${(
        inv.branchName || ''
      ).padEnd(18)} ${current} → ${correct}`,
    );
    if (!dryRun) {
      const weight = inv.product?.weight ? Number(inv.product.weight) : 0;
      await prisma.inventory.update({
        where: { id: inv.id },
        data: { onHand: correct, totalWeight: weight * correct },
      });
    }
  }

  console.log(
    `\n${dryRun ? '[DRY-RUN] ' : ''}${changed}/${inventories.length} bản ghi onHand ${
      dryRun ? 'sẽ được' : 'đã được'
    } reconcile.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
