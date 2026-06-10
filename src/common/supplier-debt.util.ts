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
/**
 * ────────────────────────────────────────────────────────────────────────────
 * CANONICAL FILTERS / AMOUNTS — nguồn chân lý DÙNG CHUNG cho cả
 * `recalcSupplierDebt` (Formula B, ghi `Supplier.debt`) lẫn
 * `SuppliersService.getDebtTimeline` (cột "Dư nợ" zigzag).
 *
 * Đối xứng triệt để với phía KH: bên KH header "Nợ hiện tại" === dòng zigzag
 * mới nhất vì hai hàm dùng CÙNG bộ lọc (vd Invoice `status notIn [2]`). Bên NCC
 * trước đây hai hàm lọc KHÁC nhau (Formula B KHÔNG loại PN đã hủy, timeline
 * loại) → header phình to hơn zigzag. Tách predicate ra đây để không bao giờ
 * lệch lại.
 *
 * PN (PurchaseOrder) chỉ có 3 status: 0=DRAFT, 1=COMPLETED, 2=CANCELLED.
 * (KHÔNG có status 4 — số 4 ở code cũ là copy nhầm từ domain đơn đặt/bán.)
 * ────────────────────────────────────────────────────────────────────────────
 */

// PN tính vào nợ: đã chốt (isDraft=false), CHƯA hủy (status≠2), chưa bị xoá mềm.
export const SUPPLIER_DEBT_PO_WHERE = {
  isDraft: false,
  status: { not: 2 },
  NOT: { code: { contains: '{DEL}' } },
};

// Giá trị nợ phát sinh của 1 PN = total − discount (đã trừ chiết khấu). Bằng
// `subTotal` lúc tạo (purchase-orders.service.ts: subTotal = total − discount).
export function supplierPoDebtAmount(po: {
  total: any;
  discount: any;
}): number {
  return Number(po.total) - Number(po.discount);
}

// SupplierReturn offset nợ: STOCK_EXPORTED(2) hoặc COMPLETED(3) với refundType
// thực (cash_refund | debt_offset). CỐ TÌNH loại `manual_offset` — đối xứng
// customer-debt.util.ts (RO offsets chỉ gồm debt_offset/cash_refund, KHÔNG
// gồm CTN manual_offset). manual_offset chỉ tái phân bổ credit giữa các PN,
// KHÔNG đổi tổng nợ → không được tính vào Formula B lẫn timeline.
export const SUPPLIER_DEBT_SR_WHERE = {
  OR: [
    { status: 2 }, // STOCK_EXPORTED
    { status: 3, refundType: 'cash_refund' }, // COMPLETED + hoàn tiền
    { status: 3, refundType: 'debt_offset' }, // COMPLETED + cấn trừ nợ
  ],
};

// Số tiền cấn trừ: status 3 (đã hoàn tất) dùng `refundedAmount`, status 2 (mới
// xuất kho, chưa hoàn tất) dùng `refundAmount`. Tại COMPLETED hai field bằng
// nhau (supplier-returns.service.ts: refundedAmount = refundAmount).
export function supplierReturnOffsetAmount(sr: {
  status: number;
  refundAmount: any;
  refundedAmount: any;
}): number {
  return sr.status === 3
    ? Number(sr.refundedAmount)
    : Number(sr.refundAmount);
}

// Prefix CashFlow CHI cần loại để tránh trừ đôi (clone PCTUPN khi PDN→PN).
export const SUPPLIER_DEBT_CASHFLOW_PAID_EXCLUDE_PREFIX = 'PCTUPN';

export async function recalcSupplierDebt(
  tx: any,
  supplierId: number,
  opts: RecalcSupplierDebtOptions = {},
): Promise<number> {
  // 1. PO subTotal (KHÔNG trừ paidAmount — tiền đi qua cashflow).
  //    Dùng SUPPLIER_DEBT_PO_WHERE → loại PN đã hủy (status 2) + xoá mềm {DEL},
  //    KHỚP chính xác với timeline. Đây là FIX: trước đây thiếu filter status
  //    nên PN đã hủy vẫn cộng vào nợ → header lớn hơn dòng zigzag.
  const purchaseOrders = await tx.purchaseOrder.findMany({
    where: { supplierId, ...SUPPLIER_DEBT_PO_WHERE },
    select: { total: true, discount: true },
  });
  const debtFromPurchases = purchaseOrders.reduce(
    (s: number, po: any) => s + supplierPoDebtAmount(po),
    0,
  );

  // `totalInvoiced` = tổng giá trị THỰC mua từ NCC (đã trừ discount). Đối
  // xứng `Customer.totalPurchased` = sum(Invoice.grandTotal). PN đã hủy không
  // tính là "đã mua" → cùng dùng filter trên.
  const totalInvoicedComputed = debtFromPurchases;

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
      NOT: [
        { code: { startsWith: SUPPLIER_DEBT_CASHFLOW_PAID_EXCLUDE_PREFIX } },
      ],
    },
    select: { amount: true },
  });
  const totalCashFlowPaid = cashFlowsPaid.reduce(
    (s: number, cf: any) => s + Number(cf.amount),
    0,
  );

  // 3. SupplierReturn offsets — đối xứng RO offsets của KH (mọi mode).
  //    Dùng SUPPLIER_DEBT_SR_WHERE + supplierReturnOffsetAmount → KHỚP timeline.
  const supplierReturns = await tx.supplierReturn.findMany({
    where: {
      supplierId,
      ...(opts.excludeSupplierReturnId
        ? { NOT: { id: opts.excludeSupplierReturnId } }
        : {}),
      ...SUPPLIER_DEBT_SR_WHERE,
    },
    select: { status: true, refundAmount: true, refundedAmount: true },
  });
  const totalSupplierReturnOffsets =
    supplierReturns.reduce(
      (s: number, sr: any) => s + supplierReturnOffsetAmount(sr),
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
