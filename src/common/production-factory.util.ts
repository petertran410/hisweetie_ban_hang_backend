// ====================================================================
// Gửi sản xuất ở nhà máy ngoài (Production.isExternal = true) — hàm dùng chung.
//
// Đặt ở common vì công thức nợ NCC (recalcSupplierDebt) và dòng thời gian
// công nợ (SuppliersService.getDebtTimeline) phải đọc CÙNG một nguồn.
//
// Quy ước công nợ:
//   - Đã gửi (4): giá vốn nguyên liệu đã gửi chỉ là "hàng NCC đang giữ",
//     theo dõi riêng (materialValue), KHÔNG cộng vào nợ phải trả NCC.
//   - Hoàn thành (2): phí sản xuất của lô cộng vào nợ phải trả NCC.
// ====================================================================

export const PRODUCTION_STATUS = {
  DRAFT: 1,
  COMPLETED: 2,
  CANCELLED: 3,
  SENT: 4,
} as const;

// Phiếu gửi đã hoàn thành có phí → phát sinh nợ NCC.
export const SUPPLIER_DEBT_PRODUCTION_FEE_WHERE = {
  isExternal: true,
  status: PRODUCTION_STATUS.COMPLETED,
  processingFee: { gt: 0 },
};

export interface ProductionFeeDebtItem {
  id: number;
  code: string;
  date: Date;
  createdAt: Date;
  amount: number;
  description: string;
  branch: { id: number; name: string };
}

/** Các khoản phí sản xuất đang tính vào nợ của 1 NCC. */
export async function getProductionFeeDebtItems(
  tx: any,
  supplierId: number,
): Promise<ProductionFeeDebtItem[]> {
  const rows = await tx.production.findMany({
    where: { supplierId, ...SUPPLIER_DEBT_PRODUCTION_FEE_WHERE },
    select: {
      id: true,
      code: true,
      productName: true,
      processingFee: true,
      completedDate: true,
      updatedAt: true,
      createdAt: true,
      destinationBranchId: true,
      destinationBranchName: true,
    },
  });
  return rows.map((r: any) => ({
    id: r.id,
    code: r.code,
    date: r.completedDate ?? r.updatedAt,
    createdAt: r.createdAt,
    amount: Number(r.processingFee),
    description: `Phí sản xuất ${r.code} (${r.productName})`,
    branch: { id: r.destinationBranchId, name: r.destinationBranchName },
  }));
}

/** Tổng giá vốn nguyên liệu NCC đang giữ (phiếu gửi ở trạng thái Đã gửi). */
export async function getHeldMaterialValue(
  tx: any,
  supplierId: number,
): Promise<number> {
  const agg = await tx.production.aggregate({
    where: { supplierId, isExternal: true, status: PRODUCTION_STATUS.SENT },
    _sum: { materialValue: true },
  });
  return Number(agg._sum.materialValue ?? 0);
}

/** Phí sản xuất quy VND: VND giữ nguyên; ngoại tệ × tỷ giá, làm tròn đồng. */
export function productionFeeInVnd(input: {
  currency: string;
  amount?: number | null;
  foreignAmount?: number | null;
  exchangeRate?: number | null;
}): number {
  if (input.currency === 'VND') return Math.round(Number(input.amount ?? 0));
  return Math.round(
    Number(input.foreignAmount ?? 0) * Number(input.exchangeRate ?? 0),
  );
}

/**
 * Giá vốn bình quân gia quyền đề xuất khi nhập thành phẩm.
 *
 *   giá mới = (tồn khác × giá cũ + SL nhận × giá thành) / (tồn khác + SL nhận)
 *
 * `otherQuantity` là tồn KHÔNG thuộc lô này. Giá cũ ≤ 0 nghĩa là tồn cũ chưa
 * từng được định giá → không cho kéo giá mới xuống, lấy luôn giá thành.
 */
export function computeWeightedAverageCost(input: {
  otherQuantity: number;
  oldCost: number;
  receivedQuantity: number;
  unitCost: number;
}): { otherQuantity: number; proposedCost: number } {
  const { oldCost, receivedQuantity, unitCost } = input;
  if (receivedQuantity <= 0) {
    return { otherQuantity: 0, proposedCost: oldCost };
  }
  const otherQuantity = oldCost > 0 ? Math.max(input.otherQuantity, 0) : 0;
  const proposedCost =
    (otherQuantity * oldCost + receivedQuantity * unitCost) /
    (otherQuantity + receivedQuantity);
  return {
    otherQuantity,
    proposedCost: Math.round(proposedCost * 100) / 100,
  };
}
