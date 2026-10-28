import { BadRequestException } from '@nestjs/common';

// ====================================================================
// Gửi sản xuất ở nhà máy ngoài (Production.isExternal = true) — hàm dùng chung.
//
// Đặt ở common vì công thức nợ NCC (recalcSupplierDebt) và dòng thời gian
// công nợ (SuppliersService.getDebtTimeline) phải đọc CÙNG một nguồn.
//
// Quy ước công nợ:
//   - Đã gửi (4): giá vốn nguyên liệu đã gửi chỉ là "hàng NCC đang giữ",
//     theo dõi riêng (materialValue), KHÔNG cộng vào nợ phải trả NCC.
//   - Nhận hàng = tạo 1 phiếu nhập (PN, PurchaseOrder.productionId) có đúng
//     1 dòng thành phẩm, giá trị = phí sản xuất. Phí vào nợ NCC qua PN nên
//     trả tiền được bằng bảng phân bổ PN như mọi phiếu nhập.
//   - Trạng thái phiếu đi theo PN: có PN đã nhập → Hoàn thành; không còn
//     (PN tạm / hủy / xóa) → Đã gửi. Xem `syncProductionFromPurchaseOrders`.
// ====================================================================

export const PRODUCTION_STATUS = {
  DRAFT: 1,
  COMPLETED: 2,
  CANCELLED: 3,
  SENT: 4,
} as const;

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

// PN còn hiệu lực của 1 phiếu sản xuất: chưa hủy (gồm cả phiếu tạm).
export const ACTIVE_PRODUCTION_PO_WHERE = { status: { not: 2 } };

/**
 * Kiểm tra PN tạo/sửa từ phiếu Gửi sản xuất: đúng NCC, đúng kho nhận, đúng
 * 1 dòng là thành phẩm, SL > 0. Trả về phiếu sản xuất.
 *
 * `excludePurchaseOrderId`: khi sửa PN thì bỏ chính nó khỏi kiểm tra "đã có
 * PN khác". Khi tạo mới, phiếu phải đang ở trạng thái Đã gửi.
 */
export async function assertProductionPurchaseOrder(
  tx: any,
  input: {
    productionId: number;
    supplierId: number;
    branchId?: number | null;
    items: { productId: number; quantity: any; conditionType?: string }[];
    excludePurchaseOrderId?: number;
  },
) {
  if (input.excludePurchaseOrderId == null) {
    // Khóa dòng phiếu tới hết transaction: 2 lần nhận hàng cùng lúc chạy nối
    // tiếp, lần sau thấy PN của lần trước và bị chặn → không sinh 2 PN.
    await tx.production.updateMany({
      where: { id: input.productionId },
      data: { updatedAt: new Date() },
    });
  }
  const production = await tx.production.findUnique({
    where: { id: input.productionId },
    select: {
      id: true,
      code: true,
      isExternal: true,
      status: true,
      supplierId: true,
      destinationBranchId: true,
      destinationBranchName: true,
      productId: true,
      productCode: true,
      productName: true,
    },
  });
  if (!production || !production.isExternal) {
    throw new BadRequestException('Không tìm thấy phiếu gửi sản xuất');
  }
  if (input.excludePurchaseOrderId == null) {
    if (production.status !== PRODUCTION_STATUS.SENT) {
      throw new BadRequestException(
        `Phiếu ${production.code} không ở trạng thái Đã gửi nên không nhập hàng được`,
      );
    }
    const existing = await tx.purchaseOrder.findFirst({
      where: { productionId: production.id, ...ACTIVE_PRODUCTION_PO_WHERE },
      select: { code: true },
    });
    if (existing) {
      throw new BadRequestException(
        `Phiếu ${production.code} đã có phiếu nhập ${existing.code}. Hủy phiếu nhập đó trước nếu muốn nhập lại.`,
      );
    }
  }
  if (production.supplierId !== input.supplierId) {
    throw new BadRequestException(
      `Phiếu nhập từ ${production.code} phải đúng nhà cung cấp của phiếu sản xuất`,
    );
  }
  if (
    input.branchId != null &&
    input.branchId !== production.destinationBranchId
  ) {
    throw new BadRequestException(
      `Phiếu nhập từ ${production.code} phải nhập vào kho ${production.destinationBranchName}`,
    );
  }
  const items = input.items || [];
  if (
    items.length !== 1 ||
    items[0].productId !== production.productId ||
    (items[0].conditionType ?? 'normal') !== 'normal'
  ) {
    throw new BadRequestException(
      `Phiếu nhập từ ${production.code} chỉ gồm 1 dòng thành phẩm ${production.productCode} - ${production.productName}`,
    );
  }
  if (!(Number(items[0].quantity) > 0)) {
    throw new BadRequestException('Số lượng thành phẩm nhận phải lớn hơn 0');
  }
  return production;
}

/** Tạo dòng tồn (onHand=0) nếu thành phẩm chưa có ở kho — PN chỉ updateMany. */
export async function ensureInventoryRow(
  tx: any,
  productId: number,
  branchId: number,
) {
  const existing = await tx.inventory.findUnique({
    where: { productId_branchId: { productId, branchId } },
    select: { id: true },
  });
  if (existing) return;
  const [product, branch] = await Promise.all([
    tx.product.findUnique({
      where: { id: productId },
      select: { code: true, name: true },
    }),
    tx.branch.findUnique({ where: { id: branchId }, select: { name: true } }),
  ]);
  await tx.inventory.create({
    data: {
      productId,
      productCode: product?.code || '',
      productName: product?.name || '',
      branchId,
      branchName: branch?.name || '',
      cost: 0,
      onHand: 0,
      totalWeight: 0,
      reserved: 0,
      onOrder: 0,
      minQuality: 0,
      maxQuality: 0,
    },
  });
}

/**
 * Giá trị phiếu sản xuất lấy từ PN đã nhập: SL nhận, phí (VND = total −
 * discount, đúng như công nợ NCC), phí ngoại tệ, ngày nhận.
 */
export function productionValuesFromPurchaseOrder(po: {
  purchaseDate: Date;
  total: any;
  discount: any;
  currency?: string | null;
  exchangeRate?: any;
  items: { quantity: any; factorySubTotal?: any }[];
}) {
  const receivedQuantity = po.items.reduce(
    (s, item) => s + Number(item.quantity),
    0,
  );
  const processingFee =
    Math.round((Number(po.total) - Number(po.discount)) * 100) / 100;
  const isCny = (po.currency || 'VND') === 'CNY';
  const rate = Number(po.exchangeRate) || 0;
  const foreignFromItems = po.items.reduce(
    (s: number | null, item) =>
      item.factorySubTotal != null
        ? (s ?? 0) + Number(item.factorySubTotal)
        : s,
    null,
  );
  const feeForeignAmount = isCny
    ? Math.round(
        (foreignFromItems ?? (rate > 0 ? processingFee / rate : 0)) * 100,
      ) / 100
    : null;
  return {
    receivedQuantity,
    processingFee,
    feeCurrency: isCny ? 'CNY' : 'VND',
    feeForeignAmount,
    feeExchangeRate: isCny ? rate : null,
    completedDate: po.purchaseDate,
  };
}

/**
 * Đồng bộ trạng thái phiếu Gửi sản xuất theo PN liên kết. Gọi sau mọi thay
 * đổi PN có `productionId` (tạo, sửa, hủy, xóa) trong cùng transaction.
 */
export async function syncProductionFromPurchaseOrders(
  tx: any,
  productionId: number,
) {
  const production = await tx.production.findUnique({
    where: { id: productionId },
    select: {
      id: true,
      isExternal: true,
      status: true,
      materialValue: true,
      processingFee: true,
    },
  });
  if (
    !production ||
    !production.isExternal ||
    production.status === PRODUCTION_STATUS.CANCELLED ||
    production.status === PRODUCTION_STATUS.DRAFT
  ) {
    return;
  }

  const po = await tx.purchaseOrder.findFirst({
    where: { productionId, isDraft: false, status: { not: 2 } },
    select: {
      purchaseDate: true,
      total: true,
      discount: true,
      currency: true,
      exchangeRate: true,
      items: { select: { quantity: true, factorySubTotal: true } },
    },
    orderBy: { id: 'desc' },
  });

  if (po) {
    const values = productionValuesFromPurchaseOrder(po);
    await tx.production.update({
      where: { id: productionId },
      data: {
        ...values,
        status: PRODUCTION_STATUS.COMPLETED,
        totalCost: Number(production.materialValue) + values.processingFee,
      },
    });
    return;
  }

  if (production.status === PRODUCTION_STATUS.COMPLETED) {
    await tx.production.update({
      where: { id: productionId },
      data: {
        status: PRODUCTION_STATUS.SENT,
        receivedQuantity: null,
        completedDate: null,
        totalCost:
          Number(production.materialValue) + Number(production.processingFee),
      },
    });
  }
}
