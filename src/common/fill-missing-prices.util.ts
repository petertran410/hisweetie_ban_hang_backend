import type { Prisma } from '@prisma/client';

/**
 * Điền giá vốn cho các dòng chứng từ không gửi `price`.
 *
 * FE bỏ trống price khi user thiếu quyền products:view_cost_price (API
 * products đã bỏ `cost`) → lấy giá vốn hiện tại của sản phẩm tại chi nhánh
 * chứng từ, để đơn giá / giá trị không bị ghi 0. Dòng đã có price giữ nguyên.
 * Sản phẩm chưa có bản ghi tồn kho ở chi nhánh → 0.
 *
 * Dùng chung cho Xuất hủy và Nhập hàng. `db` là PrismaService hoặc `tx`
 * trong transaction. Chỉ truy vấn 1 lần cho mọi dòng thiếu giá, và không
 * truy vấn gì khi tất cả dòng đều có giá. Không có chi nhánh → không truy vấn
 * (Prisma bỏ qua điều kiện `undefined`, sẽ đọc nhầm mọi chi nhánh), giá = 0.
 */
export async function fillMissingPricesFromCost<
  T extends { productId: number; price?: number | null },
>(
  db: Pick<Prisma.TransactionClient, 'inventory'>,
  details: T[],
  branchId: number | null | undefined,
): Promise<(T & { price: number })[]> {
  const missingIds = [
    ...new Set(details.filter((d) => d.price == null).map((d) => d.productId)),
  ];
  const costByProduct = new Map<number, number>();
  if (missingIds.length > 0 && branchId) {
    const inventories = await db.inventory.findMany({
      where: { branchId, productId: { in: missingIds } },
      select: { productId: true, cost: true },
    });
    for (const inv of inventories) {
      costByProduct.set(inv.productId, Number(inv.cost));
    }
  }
  return details.map((d) => ({
    ...d,
    price: d.price ?? costByProduct.get(d.productId) ?? 0,
  }));
}
