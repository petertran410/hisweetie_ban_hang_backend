// ====================================================================
// Gia công ngoài (SubcontractOrder) — hàm dùng chung.
//
// Đặt ở common (không phải trong module) vì 3 nơi cùng cần và không được
// import vòng: recalcSupplierDebt (Formula B), SuppliersService.getDebtTimeline
// và CashFlowsService.cancelInTransaction.
//
// Hai nhóm:
//   1. Hàm THUẦN tính giá thành / bình quân gia quyền (có spec).
//   2. Hàm đọc-ghi DB: recompute cache tổng của lệnh, liệt kê các khoản
//      phát sinh công nợ nhà máy.
// ====================================================================

export const SUBCONTRACT_STATUS = {
  DRAFT: 1,
  PROCESSING: 2,
  PARTIALLY_RECEIVED: 3,
  COMPLETED: 4,
  CANCELLED: 5,
} as const;

export const SUBCONTRACT_STATUS_LABEL: Record<number, string> = {
  1: 'Nháp',
  2: 'Đang gia công',
  3: 'Nhận một phần',
  4: 'Hoàn thành',
  5: 'Đã hủy',
};

export const SUBCONTRACT_RECEIPT_STATUS = { ACTIVE: 1, CANCELLED: 2 } as const;

// Lệnh CÒN HIỆU LỰC về tồn kho + công nợ: đã gửi nguyên liệu và chưa hủy.
export const SUBCONTRACT_ACTIVE_STATUSES = [2, 3, 4];

// Lệnh tính vào công nợ nhà máy — DÙNG CHUNG cho Formula B lẫn timeline để
// header "Nợ hiện tại" luôn khớp dòng cuối của timeline.
export const SUPPLIER_DEBT_SUBCONTRACT_WHERE = {
  status: { in: SUBCONTRACT_ACTIVE_STATUSES },
};

const num = (v: any): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export interface SubcontractTotalsInput {
  status: number;
  plannedQuantity: any;
  processingUnitPrice: any;
  exchangeRate: any;
  materials: Array<{
    plannedQuantity: any;
    sentQuantity: any;
    returnedQuantity: any;
    unitCost: any;
  }>;
  receipts: Array<{
    status: number;
    goodQuantity: any;
    defectQuantity: any;
    amount: any;
  }>;
  costs: Array<{ amount: any; isFactoryPayable: boolean }>;
  payments: Array<{ status: number; amount: any }>;
}

export interface SubcontractTotals {
  goodQuantity: number;
  defectQuantity: number;
  materialCost: number;
  processingCost: number;
  otherCost: number;
  totalCost: number;
  /** Giá thành thực / 1 thành phẩm đạt — chỉ có nghĩa khi lệnh đã hoàn thành. */
  unitCost: number;
  payableAmount: number;
  paidAmount: number;
  /** Ước tính cho cả lệnh theo SL kế hoạch (dùng khi chưa hoàn thành). */
  estimatedTotalCost: number;
  estimatedUnitCost: number;
}

/** Phí gia công quy VND của 1 đợt nhập (làm tròn đồng). */
export function receiptProcessingAmount(
  goodQuantity: number,
  unitPrice: number,
  exchangeRate: number,
): number {
  return Math.round(goodQuantity * unitPrice * (exchangeRate || 1));
}

/**
 * Tính toàn bộ số tổng của lệnh từ các dòng con.
 *
 *   Giá thành = NVL tiêu hao + phí gia công + chi phí khác
 *   NVL tiêu hao = Σ (đã gửi − đã trả) × giá vốn chụp lúc gửi
 *   Giá thành / đv = Giá thành / SL thành phẩm ĐẠT
 *
 * Hàng lỗi không nhập kho nên chi phí của chúng dồn vào hàng đạt.
 */
export function computeSubcontractTotals(
  order: SubcontractTotalsInput,
): SubcontractTotals {
  const isDraft = order.status === SUBCONTRACT_STATUS.DRAFT;
  const activeReceipts = order.receipts.filter(
    (r) => r.status === SUBCONTRACT_RECEIPT_STATUS.ACTIVE,
  );

  const goodQuantity = activeReceipts.reduce(
    (s, r) => s + num(r.goodQuantity),
    0,
  );
  const defectQuantity = activeReceipts.reduce(
    (s, r) => s + num(r.defectQuantity),
    0,
  );

  // Nháp chưa xuất kho → chưa có NVL tiêu hao thực; ước tính theo kế hoạch.
  const consumedValue = order.materials.reduce(
    (s, m) =>
      s + (num(m.sentQuantity) - num(m.returnedQuantity)) * num(m.unitCost),
    0,
  );
  const plannedMaterialValue = order.materials.reduce(
    (s, m) => s + num(m.plannedQuantity) * num(m.unitCost),
    0,
  );

  const materialCost = isDraft ? 0 : round2(consumedValue);
  const processingCost = round2(
    activeReceipts.reduce((s, r) => s + num(r.amount), 0),
  );
  const otherCost = round2(order.costs.reduce((s, c) => s + num(c.amount), 0));
  const totalCost = round2(materialCost + processingCost + otherCost);

  const unitCost =
    order.status === SUBCONTRACT_STATUS.COMPLETED && goodQuantity > 0
      ? round6(totalCost / goodQuantity)
      : 0;

  const factoryPayableCosts = order.costs
    .filter((c) => c.isFactoryPayable)
    .reduce((s, c) => s + num(c.amount), 0);
  // Chỉ lệnh còn hiệu lực mới phát sinh nợ — khớp SUPPLIER_DEBT_SUBCONTRACT_WHERE
  // (lệnh nháp chưa phát sinh, lệnh hủy đã bị loại khỏi công nợ NCC).
  const payableAmount = SUBCONTRACT_ACTIVE_STATUSES.includes(order.status)
    ? round2(processingCost + factoryPayableCosts)
    : 0;

  const paidAmount = round2(
    order.payments
      .filter((p) => p.status !== 2)
      .reduce((s, p) => s + num(p.amount), 0),
  );

  const planned = num(order.plannedQuantity);
  const estimatedProcessing =
    planned * num(order.processingUnitPrice) * (num(order.exchangeRate) || 1);
  const estimatedTotalCost = round2(
    (isDraft ? plannedMaterialValue : consumedValue) +
      estimatedProcessing +
      otherCost,
  );
  const estimatedUnitCost =
    planned > 0 ? round6(estimatedTotalCost / planned) : 0;

  return {
    goodQuantity,
    defectQuantity,
    materialCost,
    processingCost,
    otherCost,
    totalCost,
    unitCost,
    payableAmount,
    paidAmount,
    estimatedTotalCost,
    estimatedUnitCost,
  };
}

/**
 * Giá vốn bình quân gia quyền đề xuất khi nhập thành phẩm gia công.
 *
 *   tồn khác = max(tồn hiện tại − SL đạt của lệnh, 0)
 *   giá mới  = (tồn khác × giá cũ + SL đạt × giá thành) / (tồn khác + SL đạt)
 *
 * Giá cũ ≤ 0 nghĩa là tồn cũ chưa từng được định giá → không cho nó kéo giá
 * mới xuống, lấy luôn giá thành của lệnh.
 */
export function computeWeightedAverageCost(input: {
  onHand: number;
  oldCost: number;
  goodQuantity: number;
  unitCost: number;
}): { otherQuantity: number; proposedCost: number } {
  const { onHand, oldCost, goodQuantity, unitCost } = input;
  if (goodQuantity <= 0) return { otherQuantity: 0, proposedCost: oldCost };

  const otherQuantity = oldCost > 0 ? Math.max(onHand - goodQuantity, 0) : 0;
  const proposedCost =
    (otherQuantity * oldCost + goodQuantity * unitCost) /
    (otherQuantity + goodQuantity);
  return { otherQuantity, proposedCost: round2(proposedCost) };
}

/** Tính lại và GHI các cột cache tổng của lệnh. Trả về số tổng mới. */
export async function recomputeSubcontractOrderTotals(
  tx: any,
  orderId: number,
): Promise<SubcontractTotals | null> {
  const order = await tx.subcontractOrder.findUnique({
    where: { id: orderId },
    include: { materials: true, receipts: true, costs: true, payments: true },
  });
  if (!order) return null;

  const totals = computeSubcontractTotals(order);
  await tx.subcontractOrder.update({
    where: { id: orderId },
    data: {
      goodQuantity: totals.goodQuantity,
      defectQuantity: totals.defectQuantity,
      materialCost: totals.materialCost,
      processingCost: totals.processingCost,
      otherCost: totals.otherCost,
      totalCost: totals.totalCost,
      unitCost: totals.unitCost,
      payableAmount: totals.payableAmount,
      paidAmount: totals.paidAmount,
    },
  });
  return totals;
}

export interface SubcontractDebtItem {
  kind: 'receipt' | 'cost';
  id: number;
  code: string;
  orderId: number;
  orderCode: string;
  date: Date;
  createdAt: Date;
  amount: number;
  description: string;
  branch: { id: number; name: string } | null;
}

/**
 * Các khoản PHÁT SINH NỢ nhà máy của 1 NCC: phí gia công từng đợt nhập còn
 * hiệu lực + các dòng chi phí "trả cho nhà máy", của lệnh chưa hủy.
 *
 * NGUỒN DUY NHẤT cho cả recalcSupplierDebt (cộng tổng) lẫn getDebtTimeline
 * (từng dòng) — hai nơi không được tự lọc riêng.
 */
export async function getSubcontractDebtItems(
  tx: any,
  supplierId: number,
): Promise<SubcontractDebtItem[]> {
  const orders = await tx.subcontractOrder.findMany({
    where: { supplierId, ...SUPPLIER_DEBT_SUBCONTRACT_WHERE },
    select: {
      id: true,
      code: true,
      branchId: true,
      branchName: true,
      receipts: {
        where: { status: SUBCONTRACT_RECEIPT_STATUS.ACTIVE },
        select: {
          id: true,
          code: true,
          receivedDate: true,
          createdAt: true,
          amount: true,
        },
      },
      costs: {
        where: { isFactoryPayable: true },
        select: {
          id: true,
          name: true,
          costDate: true,
          createdAt: true,
          amount: true,
        },
      },
    },
  });

  const items: SubcontractDebtItem[] = [];
  for (const o of orders) {
    const branch = { id: o.branchId, name: o.branchName };
    for (const r of o.receipts) {
      items.push({
        kind: 'receipt',
        id: r.id,
        code: r.code,
        orderId: o.id,
        orderCode: o.code,
        date: r.receivedDate,
        createdAt: r.createdAt,
        amount: num(r.amount),
        description: `Phí gia công ${r.code}`,
        branch,
      });
    }
    for (const c of o.costs) {
      items.push({
        kind: 'cost',
        id: c.id,
        code: o.code,
        orderId: o.id,
        orderCode: o.code,
        date: c.costDate,
        createdAt: c.createdAt,
        amount: num(c.amount),
        description: `${c.name} (${o.code})`,
        branch,
      });
    }
  }
  return items;
}
