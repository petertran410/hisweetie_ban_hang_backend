import type { FinanceAuditAction } from './finance-audit.catalog';

/**
 * Mã lịch sử (FIN_*) mà mỗi route ghi dữ liệu (POST / PUT / PATCH / DELETE) của
 * các controller tài chính nội bộ có thể ghi, tính cả nhánh có điều kiện. Khóa:
 * `<ControllerClass>.<handlerName>`. `[]` = route không ghi dữ liệu tài chính
 * hoặc luôn báo lỗi (có ghi chú lý do).
 *
 * finance-audit.coverage.spec.ts đối chiếu bản đồ này với metadata route của
 * Nest: thêm / đổi tên route ghi dữ liệu thì phải cập nhật ở đây.
 *
 * Mã đến từ các bước dùng chung:
 * - Sổ quỹ (InternalFundLedgerService): postSystemTransaction / postExpenseRow /
 *   applyApproval → FIN_FUND_TXN_POST; cancelBySource / releaseCancelled →
 *   FIN_FUND_TXN_CANCEL; ghi hoặc hủy dòng quỹ kéo theo invalidateClosings →
 *   FIN_FUND_CLOSING_INVALIDATE (chỉ khi có chốt sổ thật sự chuyển sang cần
 *   đối soát lại); detachFromBatch → FIN_ENTRY_BATCH_REMOVE (+ FIN_BATCH_CANCEL
 *   khi batch hết phiếu); applyApproval của chuyển quỹ → FIN_FUND_TRANSFER_STATUS.
 * - Tiền mặt kho (syncWarehouseReceiptFund): hủy dòng quỹ cũ rồi ghi dòng mới
 *   theo số kế toán kho xác nhận → FIN_FUND_TXN_CANCEL / FIN_FUND_TXN_POST.
 * - Đơn Lark (ApprovalLifecycleService.create): FIN_APPROVAL_CREATE, gửi Lark lỗi
 *   → FIN_APPROVAL_CREATE_FAILED. Sự kiện Lark về trước khi lưu mã đơn
 *   (replayOrphanEvents) được xử lý ngay trong request: FIN_APPROVAL_STATUS và
 *   kết quả của đơn (sổ quỹ / Approval tuần).
 */
const ROUTES = {
  // ---- InternalFinanceController (src/internal-finance) ----

  // createManualEntry
  'InternalFinanceController.createWarehouseExpense': ['FIN_ENTRY_CREATE'],
  // checkWarehouseExpense(checked: true) từng phiếu: kho bỏ tick → rút batch
  // (chỉ khi phiếu đang trong batch mà thiếu tick kia); VPSG tick Kế toán là
  // Đã chi → issueReviewedExpense ghi quỹ.
  'InternalFinanceController.bulkCheckWarehouseExpenses': [
    'FIN_ENTRY_CHECK',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // entryUpdateLog (chỉ khi có thay đổi; chứng từ thêm / gỡ nằm trong changes)
  'InternalFinanceController.updateWarehouseExpense': ['FIN_ENTRY_UPDATE'],
  // prepareWeeklyBatchInternal (gom lại không đổi gì thì không ghi; phiếu còn
  // trong batch đổi trạng thái → FIN_ENTRY_WEEKLY_STATUS)
  'InternalFinanceController.prepareWarehouseExpenseBatch': [
    'FIN_BATCH_PREPARE',
    'FIN_BATCH_REPREPARE',
    'FIN_ENTRY_BATCH_ADD',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_ENTRY_WEEKLY_STATUS',
  ],
  // createWeeklyApproval; replay sự kiện Lark của đơn tuần: duyệt (kho tự ghi
  // quỹ + Đã chi) hoặc từ chối / thu hồi (cancelWeeklyBatchInTx).
  'InternalFinanceController.createWarehouseExpenseApproval': [
    'FIN_BATCH_SUBMIT',
    'FIN_ENTRY_WEEKLY_STATUS',
    'FIN_BATCH_SUBMIT_FAILED',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_BATCH_LARK_STATUS',
    'FIN_BATCH_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_FUND_TXN_POST',
    'FIN_ENTRY_CASH_ISSUE',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFinanceController.addCarryOverEntries': [
    'FIN_BATCH_ADD_ENTRIES',
    'FIN_ENTRY_BATCH_ADD',
  ],
  // Hết phiếu thì tự hủy batch.
  'InternalFinanceController.removeWeeklyBatchEntries': [
    'FIN_BATCH_REMOVE_ENTRIES',
    'FIN_BATCH_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
  ],
  // cancelWeeklyBatchInTx
  'InternalFinanceController.cancelWarehouseExpenseBatch': [
    'FIN_BATCH_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
  ],
  // cancelExpenseInTx (phiếu trong batch chưa gửi được rút ra trước)
  'InternalFinanceController.cancelWarehouseExpense': [
    'FIN_ENTRY_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
  ],
  // syncEntryAttachments; ghi khi có file thêm / gỡ hoặc trạng thái chứng từ
  // đổi, không đổi gì thì không ghi.
  'InternalFinanceController.replaceWarehouseExpenseAttachments': [
    'FIN_ENTRY_ATTACHMENTS_CHANGE',
  ],
  // WarehouseExpenseNotesService.create
  'InternalFinanceController.createWarehouseExpenseNote': [
    'FIN_ENTRY_NOTE_ADD',
  ],
  // InternalFundService.postExpenseEntry → ledger.issueExpense (chi ngoài
  // Approval tuần thì phiếu rời batch chưa gửi)
  'InternalFinanceController.markWarehouseExpenseIssued': [
    'FIN_ENTRY_CASH_ISSUE',
    'FIN_FUND_TXN_POST',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // Kho: tick / bỏ tick (bỏ tick khi đang trong batch → rút batch). VPSG:
  // tick Kế toán = Đã chi (issueReviewedExpense), bỏ tick = hoàn quỹ
  // (revertReviewedExpense).
  'InternalFinanceController.checkWarehouseExpense': [
    'FIN_ENTRY_CHECK',
    'FIN_ENTRY_UNCHECK',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFinanceController.createWarehouseReceipt': ['FIN_ENTRY_CREATE'],
  // entryUpdateLog + syncWarehouseReceiptFund (đổi số / ngày / kho)
  'InternalFinanceController.updateWarehouseReceipt': [
    'FIN_ENTRY_UPDATE',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFinanceController.confirmWarehouseReceiptAmount': [
    'FIN_ENTRY_CONFIRM_AMOUNT',
    'FIN_ENTRY_CONFIRM_CLEAR',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // Bước cuối (transaction) + ghi bù quỹ cho phiếu xác nhận trước khi đổi
  // cách ghi quỹ; lỗi sau khi đã khóa phiếu / tạo phiếu thu → POST_FAILED.
  'InternalFinanceController.postWarehouseReceipt': [
    'FIN_ENTRY_POST',
    'FIN_ENTRY_POST_FAILED',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // cancelWarehouseReceiptCore (rút tiền khỏi quỹ khi hủy kèm phiếu thu hoặc
  // chưa có phiếu thu)
  'InternalFinanceController.cancelWarehouseReceipt': [
    'FIN_ENTRY_CANCEL',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFinanceController.createManualReceipt': ['FIN_ENTRY_CREATE'],
  // createManualEntry
  'InternalFinanceController.createManualExpense': ['FIN_ENTRY_CREATE'],
  'InternalFinanceController.createFuel': ['FIN_ENTRY_CREATE'],
  'InternalFinanceController.createVehicleCare': ['FIN_ENTRY_CREATE'],
  'InternalFinanceController.createFuelAdvanceEntry': [
    'FIN_FUEL_ADVANCE_CREATE',
  ],
  'InternalFinanceController.cancelFuelAdvanceEntry': [
    'FIN_FUEL_ADVANCE_CANCEL',
  ],
  'InternalFinanceController.updateVehicleEntry': ['FIN_ENTRY_UPDATE'],
  // cancelExpenseInTx
  'InternalFinanceController.cancelVehicleEntry': [
    'FIN_ENTRY_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
  ],
  // applyReview
  'InternalFinanceController.review': ['FIN_ENTRY_REVIEW', 'FIN_ENTRY_REJECT'],
  'InternalFinanceController.accountantReview': [
    'FIN_ENTRY_REVIEW',
    'FIN_ENTRY_REJECT',
  ],
  'InternalFinanceController.managerReview': [
    'FIN_ENTRY_REVIEW',
    'FIN_ENTRY_REJECT',
  ],
  'InternalFinanceController.addAttachments': ['FIN_ENTRY_ATTACHMENTS_CHANGE'],
  // postEntry luôn báo lỗi (khoản chi đi theo Approval tuần, phiếu thu dùng
  // Quỹ nội bộ / Tiền mặt kho): không ghi gì.
  'InternalFinanceController.postEntry': [],
  // InternalFundService.postExpenseEntry (cashIssued=false luôn báo lỗi)
  'InternalFinanceController.updateCashIssued': [
    'FIN_ENTRY_CASH_ISSUE',
    'FIN_FUND_TXN_POST',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFinanceController.normalizeLegacyCodes': [
    'FIN_ENTRY_CODE_NORMALIZE',
  ],
  // prepareWeeklyBatchInternal (gom lại không đổi gì thì không ghi; phiếu còn
  // trong batch đổi trạng thái → FIN_ENTRY_WEEKLY_STATUS)
  'InternalFinanceController.prepareWeeklyBatch': [
    'FIN_BATCH_PREPARE',
    'FIN_BATCH_REPREPARE',
    'FIN_ENTRY_BATCH_ADD',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_ENTRY_WEEKLY_STATUS',
  ],
  // Như createWarehouseExpenseApproval (cùng createWeeklyApproval).
  'InternalFinanceController.createWeeklyApproval': [
    'FIN_BATCH_SUBMIT',
    'FIN_ENTRY_WEEKLY_STATUS',
    'FIN_BATCH_SUBMIT_FAILED',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_BATCH_LARK_STATUS',
    'FIN_BATCH_CANCEL',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_FUND_TXN_POST',
    'FIN_ENTRY_CASH_ISSUE',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // postWeeklyBatch luôn báo lỗi (Đã chi đánh dấu trên từng dòng): không ghi gì.
  'InternalFinanceController.postWeeklyBatch': [],

  // ---- InternalFundController (src/internal-fund) ----

  // Chỉ tải file lên Lark Approval, không ghi DB.
  'InternalFundController.uploadFile': [],
  // createReceiptApproval (chuyển quỹ); replay sự kiện Lark: applyApproval.
  'InternalFundController.createTransfer': [
    'FIN_FUND_TRANSFER_REQUEST',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_FUND_TRANSFER_STATUS',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // createReceiptApproval (classification INTERNAL_TRANSFER cũng đi được đường này)
  'InternalFundController.createReceipt': [
    'FIN_FUND_TRANSFER_REQUEST',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_FUND_TRANSFER_STATUS',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFundController.updateTransaction': ['FIN_FUND_TXN_ADJUST'],
  // Dòng chuyển quỹ → cancelTransfer; dòng của đơn Lark → hủy cả phiếu; khoản
  // chi POS → bỏ Đã chi; còn lại hủy trực tiếp.
  'InternalFundController.cancelTransaction': [
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_TRANSFER_CANCEL',
    'FIN_ENTRY_CANCEL',
    'FIN_ENTRY_CASH_ISSUE_REVERT',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // Chỉ kiểm tra quyền / trạng thái rồi trả dòng quỹ, không ghi gì.
  'InternalFundController.postTransaction': [],
  // postExpenseEntry → ledger.issueExpense
  'InternalFundController.postExpense': [
    'FIN_ENTRY_CASH_ISSUE',
    'FIN_FUND_TXN_POST',
    'FIN_ENTRY_BATCH_REMOVE',
    'FIN_BATCH_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFundController.createReceiptApproval': [
    'FIN_FUND_TRANSFER_REQUEST',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_FUND_TRANSFER_STATUS',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  // postApprovedApproval → ledger.applyApproval
  'InternalFundController.postApproval': [
    'FIN_APPROVAL_POST',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_TRANSFER_STATUS',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'InternalFundController.closeDay': ['FIN_FUND_CLOSING_SAVE'],
  'InternalFundController.cancelTransfer': [
    'FIN_FUND_TRANSFER_CANCEL',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],

  // ---- InternalFundApprovalController (src/internal-fund) ----

  // createReceiptApproval
  'InternalFundApprovalController.create': [
    'FIN_FUND_TRANSFER_REQUEST',
    'FIN_APPROVAL_CREATE',
    'FIN_APPROVAL_CREATE_FAILED',
    'FIN_APPROVAL_STATUS',
    'FIN_FUND_TRANSFER_STATUS',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],

  // ---- VehiclesController (src/vehicles) ----

  'VehiclesController.create': ['FIN_VEHICLE_CREATE'],
  // updateEntries: mỗi loại thay đổi một dòng; không đổi gì thì không ghi.
  'VehiclesController.update': [
    'FIN_VEHICLE_UPDATE',
    'FIN_VEHICLE_RENAME',
    'FIN_VEHICLE_DEACTIVATE',
    'FIN_VEHICLE_REACTIVATE',
  ],

  // ---- VpsgCashController (src/vpsg-cash) ----

  // Ghi lại giao dịch đã có dòng quỹ thì không ghi lịch sử.
  'VpsgCashController.record': [
    'FIN_VPSG_RECORD',
    'FIN_FUND_TXN_POST',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
  'VpsgCashController.cancel': [
    'FIN_VPSG_CANCEL',
    'FIN_FUND_TXN_CANCEL',
    'FIN_FUND_CLOSING_INVALIDATE',
  ],
} satisfies Record<string, readonly FinanceAuditAction[]>;

export const FINANCE_ROUTE_AUDIT: Record<string, readonly string[]> = ROUTES;
