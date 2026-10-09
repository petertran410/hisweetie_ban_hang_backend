interface RecalcDebtOptions {
  excludeReturnOrderId?: number; // bỏ 1 RO đang chuyển trạng thái khỏi cấn trừ
  extraDebtOffset?: number; // cộng thêm cấn trừ thủ công (RO hiện tại sắp sang status 4)
  totalPurchased?: number; // ghi luôn totalPurchased (cho invoices.service)
  syncTotalPurchased?: boolean; // ghi totalPurchased = Σ grandTotal HĐ chưa hủy (đã tính sẵn ở đây)
}

/**
 * Hook đẩy khách hàng lên Lark khi công nợ biến động.
 * recalcCustomerDebt là plain function (không DI được), nên LarkCustomerSyncService
 * tự đăng ký callback lúc khởi tạo qua setCustomerChangedHook(). Mọi nguồn biến
 * động tiền (orders, invoices, payments, return, cashflow, import...) đều đi qua
 * recalcCustomerDebt nên hook ở đây bắt được hết.
 */
type CustomerChangedHook = (customerId: number) => void;
let onCustomerChanged: CustomerChangedHook | null = null;
const additionalCustomerChangedHooks = new Set<CustomerChangedHook>();

export function setCustomerChangedHook(fn: CustomerChangedHook | null): void {
  onCustomerChanged = fn;
}

/** Đăng ký thêm consumer mà không ghi đè hook đồng bộ Lark hiện có. */
export function addCustomerChangedHook(fn: CustomerChangedHook): () => void {
  additionalCustomerChangedHooks.add(fn);
  return () => additionalCustomerChangedHooks.delete(fn);
}

// Formula A — NGUỒN CHÂN LÝ DUY NHẤT. Tính nợ RIÊNG của 1 khách, ghi + trả về totalDebt.
export async function recalcCustomerDebt(
  tx: any,
  customerId: number,
  opts: RecalcDebtOptions = {},
): Promise<number> {
  const invoiceSum = await tx.invoice.aggregate({
    where: { customerId, status: { notIn: [2] } },
    _sum: { grandTotal: true },
  });
  const totalGrandTotal = Number(invoiceSum._sum.grandTotal || 0);

  // THU — loại TTTUHD; GIỮ CB (nợ đầu kỳ)
  const receiptSum = await tx.cashFlow.aggregate({
    where: {
      partnerId: customerId,
      partnerType: 'C',
      isReceipt: true,
      status: { not: 2 },
      NOT: [{ code: { startsWith: 'TTTUHD' } }],
    },
    _sum: { amount: true },
  });
  const totalCashFlowReceived = Number(receiptSum._sum.amount || 0);

  // CHI — GIỮ CB
  const paidOutSum = await tx.cashFlow.aggregate({
    where: {
      partnerId: customerId,
      partnerType: 'C',
      isReceipt: false,
      status: { not: 2 },
    },
    _sum: { amount: true },
  });
  const totalCashFlowPaidOut = Number(paidOutSum._sum.amount || 0);

  // Cấn trừ trả hàng (đầy đủ 3 trạng thái)
  const offsetSum = await tx.returnOrder.aggregate({
    where: {
      customerId,
      ...(opts.excludeReturnOrderId
        ? { NOT: { id: opts.excludeReturnOrderId } }
        : {}),
      OR: [
        { status: 2 },
        { status: 4, refundType: 'debt_offset' },
        { status: 4, refundType: 'cash_refund' },
      ],
    },
    _sum: { refundAmount: true },
  });
  const totalDebtOffsets =
    Number(offsetSum._sum.refundAmount || 0) + (opts.extraDebtOffset || 0);

  const totalDebt =
    totalGrandTotal -
    totalCashFlowReceived +
    totalCashFlowPaidOut -
    totalDebtOffsets;

  await tx.customer.update({
    where: { id: customerId },
    data:
      opts.totalPurchased !== undefined
        ? { totalDebt, totalPurchased: opts.totalPurchased }
        : opts.syncTotalPurchased
          ? { totalDebt, totalPurchased: totalGrandTotal }
          : { totalDebt },
  });

  // Đẩy lên Lark (fire-and-forget). Bọc try/catch để không bao giờ ảnh hưởng
  // transaction nghiệp vụ nếu hook lỗi.
  try {
    onCustomerChanged?.(customerId);
    for (const hook of additionalCustomerChangedHooks) hook(customerId);
  } catch {
    /* noop — sync Lark không được phép làm hỏng luồng công nợ */
  }

  return totalDebt;
}
