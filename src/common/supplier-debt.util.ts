interface RecalcSupplierDebtOptions {
  /**
   * Bỏ 1 supplier-return ra khỏi offsets — dùng khi RO đang chuyển trạng thái
   * trong cùng transaction nhưng chưa được commit DB.
   */
  excludeSupplierReturnId?: number;

  /**
   * Cộng thêm 1 offset thủ công (cho RO sắp sang STOCK_EXPORTED/COMPLETED nhưng
   * chưa update DB). Đối xứng `extraDebtOffset` của recalcCustomerDebt.
   */
  extraSupplierReturnOffset?: number;

  /**
   * Ghi luôn `totalInvoiced` cho supplier (đối xứng `totalPurchased` ở KH).
   */
  totalInvoiced?: number;
}

export async function recalcSupplierDebt(
  tx: any,
  supplierId: number,
  opts: RecalcSupplierDebtOptions = {},
): Promise<number> {
  // 1. PO subTotal − paidAmount
  const purchaseOrders = await tx.purchaseOrder.findMany({
    where: { supplierId, isDraft: false },
    select: { total: true, discount: true, paidAmount: true },
  });
  const debtFromPurchases = purchaseOrders.reduce(
    (s: number, po: any) =>
      s + (Number(po.total) - Number(po.discount) - Number(po.paidAmount)),
    0,
  );

  const totalInvoicedComputed = purchaseOrders.reduce(
    (s: number, po: any) => s + Number(po.total),
    0,
  );

  // 2. OrderSupplierPayment (ứng trước đặt hàng nhập, proxy của cashflow PDNPC)
  const orderSuppliers = await tx.orderSupplier.findMany({
    where: { supplierId },
    include: { payments: true },
  });
  const debtFromOrderPayments = orderSuppliers.reduce(
    (s: number, os: any) =>
      s + os.payments.reduce((ss: number, p: any) => ss + Number(p.amount), 0),
    0,
  );

  // 3. CashFlow S — loại trừ PNPC* (đã ở po.paidAmount) và PDNPC* (đã ở orderSupplierPayment).
  const cashFlowsReceipt = await tx.cashFlow.findMany({
    where: {
      partnerId: supplierId,
      partnerType: 'S',
      isReceipt: true,
      status: { not: 2 },
      NOT: [
        { code: { startsWith: 'PNPC' } },
        { code: { startsWith: 'PDNPC' } },
      ],
    },
    select: { amount: true },
  });
  const totalCashFlowReceived = cashFlowsReceipt.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  const cashFlowsPaid = await tx.cashFlow.findMany({
    where: {
      partnerId: supplierId,
      partnerType: 'S',
      isReceipt: false,
      status: { not: 2 },
      NOT: [
        { code: { startsWith: 'PNPC' } },
        { code: { startsWith: 'PDNPC' } },
      ],
    },
    select: { amount: true },
  });
  const totalCashFlowPaid = cashFlowsPaid.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  // 4. SupplierReturn offsets
  const supplierReturns = await tx.supplierReturn.findMany({
    where: {
      supplierId,
      ...(opts.excludeSupplierReturnId
        ? { NOT: { id: opts.excludeSupplierReturnId } }
        : {}),
      OR: [
        { status: 2 }, // STOCK_EXPORTED
        { status: 3, refundType: 'cash_refund' }, // COMPLETED + cash_refund
        { status: 3, refundType: 'debt_offset', mode: 'by_product' }, // COMPLETED + debt_offset + by_product
      ],
    },
    select: { refundAmount: true },
  });
  const totalSupplierReturnOffsets =
    supplierReturns.reduce(
      (s: number, sr: any) => s + Number(sr.refundAmount),
      0,
    ) + (opts.extraSupplierReturnOffset || 0);

  const totalDebt =
    debtFromPurchases -
    debtFromOrderPayments +
    totalCashFlowReceived -
    totalCashFlowPaid -
    totalSupplierReturnOffsets;

  await tx.supplier.update({
    where: { id: supplierId },
    data:
      opts.totalInvoiced !== undefined
        ? { debt: totalDebt, totalInvoiced: opts.totalInvoiced }
        : { debt: totalDebt, totalInvoiced: totalInvoicedComputed },
  });

  return totalDebt;
}
