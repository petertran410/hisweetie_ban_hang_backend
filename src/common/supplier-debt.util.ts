interface RecalcSupplierDebtOptions {
  /**
   * Bỏ 1 supplier-return ra khỏi offsets — dùng khi SR đang chuyển trạng thái
   * trong cùng transaction nhưng chưa được commit DB.
   */
  excludeSupplierReturnId?: number;

  /**
   * Cộng thêm 1 offset thủ công (cho SR sắp sang STOCK_EXPORTED/COMPLETED nhưng
   * chưa update DB). Đối xứng `extraDebtOffset` của recalcCustomerDebt.
   */
  extraSupplierReturnOffset?: number;

  /**
   * Ghi luôn `totalInvoiced` cho supplier (đối xứng `totalPurchased` ở KH).
   */
  totalInvoiced?: number;
}

/**
 * Formula B — NGUỒN CHÂN LÝ DUY NHẤT cho `Supplier.debt`.
 *
 * Đối xứng triệt để với `recalcCustomerDebt` (Formula A) nhưng đảo dấu cashFlow
 * vì hướng nợ ngược lại:
 *
 *   KH:  totalDebt = +Σ(Invoice.grandTotal) − Σ(cashFlow.C.recv) + Σ(cashFlow.C.paid) − Σ(returnOrderOffsets)
 *   NCC: debt      = +Σ(PO.subTotal)        + Σ(cashFlow.S.recv) − Σ(cashFlow.S.paid) − Σ(supplierReturnOffsets)
 *
 * Hệ quả:
 *   - Mọi tiền ĐI QUA cashFlow. PO.paidAmount và orderSupplierPayment.amount
 *     KHÔNG dùng làm input của công thức (chúng chỉ là field cache hiển thị UI).
 *   - Khi cashFlow bị soft-cancel (status=2), filter loại nó ra → debt tự đồng bộ.
 *
 * EXCLUDE PREFIX `PCTUPN` (đối xứng `TTTUHD` của KH):
 *   - Khi tạo PurchaseOrder TỪ OrderSupplier có thanh toán trước, code clone
 *     OrderSupplierPayment → PurchaseOrderPayment + tạo CashFlow MỚI với code
 *     `PCTUPN{poCode}-N`. CashFlow GỐC của OrderSupplier (`PCPDN######`) vẫn
 *     giữ nguyên làm single source. Nếu KHÔNG filter, formula sẽ trừ ĐÔI khoản
 *     paid này khỏi debt.
 *   - Đây là cơ chế chống double-count đối xứng triệt để với phía bán
 *     (xem `customer-debt.util.ts:29` filter `TTTUHD`).
 *
 * Filter SupplierReturn offsets (đối xứng RO offsets của KH):
 *   - status = STOCK_EXPORTED(2)
 *   - HOẶC status = COMPLETED(3) AND refundType = 'cash_refund'
 *   - HOẶC status = COMPLETED(3) AND refundType = 'debt_offset'
 *
 *   (KH dùng status=2 OR status=4+debt_offset OR status=4+cash_refund — tương tự
 *    nhưng số status khác do quy ước domain khác.)
 */
export async function recalcSupplierDebt(
  tx: any,
  supplierId: number,
  opts: RecalcSupplierDebtOptions = {},
): Promise<number> {
  // 1. PO subTotal (KHÔNG trừ paidAmount — tiền đi qua cashflow)
  const purchaseOrders = await tx.purchaseOrder.findMany({
    where: { supplierId, isDraft: false },
    select: { total: true, discount: true },
  });
  const debtFromPurchases = purchaseOrders.reduce(
    (s: number, po: any) => s + (Number(po.total) - Number(po.discount)),
    0,
  );

  const totalInvoicedComputed = purchaseOrders.reduce(
    (s: number, po: any) => s + Number(po.total),
    0,
  );

  // 2. CashFlow S — đối xứng KH.
  //    THU (isReceipt=true) cộng vào debt: hoàn tiền/thu lại từ NCC. Không filter prefix.
  //    CHI (isReceipt=false) trừ debt: tiền đã trả NCC. Filter prefix `PCTUPN`
  //    để loại CashFlow CLONE khi tạo PN từ PDN — tránh trừ đôi với CashFlow gốc
  //    `PCPDN######` của OrderSupplier.
  const cashFlowsReceipt = await tx.cashFlow.findMany({
    where: {
      partnerId: supplierId,
      partnerType: 'S',
      isReceipt: true,
      status: { not: 2 },
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
      NOT: [{ code: { startsWith: 'PCTUPN' } }],
    },
    select: { amount: true },
  });
  const totalCashFlowPaid = cashFlowsPaid.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  // 3. SupplierReturn offsets — đối xứng RO offsets của KH (mọi mode)
  const supplierReturns = await tx.supplierReturn.findMany({
    where: {
      supplierId,
      ...(opts.excludeSupplierReturnId
        ? { NOT: { id: opts.excludeSupplierReturnId } }
        : {}),
      OR: [
        { status: 2 }, // STOCK_EXPORTED
        { status: 3, refundType: 'cash_refund' },
        { status: 3, refundType: 'debt_offset' },
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
    debtFromPurchases +
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
