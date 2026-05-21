interface RecalcDebtOptions {
  excludeReturnOrderId?: number; // bỏ 1 RO đang chuyển trạng thái khỏi cấn trừ
  extraDebtOffset?: number; // cộng thêm cấn trừ thủ công (RO hiện tại sắp sang status 4)
  totalPurchased?: number; // ghi luôn totalPurchased (cho invoices.service)
}

// Formula A — NGUỒN CHÂN LÝ DUY NHẤT. Tính nợ RIÊNG của 1 khách, ghi + trả về totalDebt.
export async function recalcCustomerDebt(
  tx: any,
  customerId: number,
  opts: RecalcDebtOptions = {},
): Promise<number> {
  const invoices = await tx.invoice.findMany({
    where: { customerId, status: { notIn: [2] } },
    select: { grandTotal: true },
  });
  const totalGrandTotal = invoices.reduce(
    (s: number, inv: any) => s + Number(inv.grandTotal),
    0,
  );

  // THU — loại TTTUHD; GIỮ CB (nợ đầu kỳ)
  const cashFlowsReceipt = await tx.cashFlow.findMany({
    where: {
      partnerId: customerId,
      partnerType: 'C',
      isReceipt: true,
      status: { not: 2 },
      NOT: [{ code: { startsWith: 'TTTUHD' } }],
    },
    select: { amount: true },
  });
  const totalCashFlowReceived = cashFlowsReceipt.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  // CHI — GIỮ CB
  const cashFlowsPaidOut = await tx.cashFlow.findMany({
    where: {
      partnerId: customerId,
      partnerType: 'C',
      isReceipt: false,
      status: { not: 2 },
    },
    select: { amount: true },
  });
  const totalCashFlowPaidOut = cashFlowsPaidOut.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  // Cấn trừ trả hàng (đầy đủ 3 trạng thái)
  const debtOffsets = await tx.returnOrder.findMany({
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
    select: { refundAmount: true },
  });
  const totalDebtOffsets =
    debtOffsets.reduce((s: number, ro: any) => s + Number(ro.refundAmount), 0) +
    (opts.extraDebtOffset || 0);

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
        : { totalDebt },
  });

  return totalDebt;
}
