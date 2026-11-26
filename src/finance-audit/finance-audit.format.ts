import { Prisma } from '@prisma/client';
import {
  FINANCE_AUDIT_CATALOG,
  type FinanceAuditAction,
} from './finance-audit.catalog';
import {
  FINANCE_AUDIT_ENTITY,
  type FinanceAuditChange,
  type FinanceAuditEntityType,
  type FinanceAuditParams,
} from './finance-audit.types';

// Định dạng hiển thị cho lịch sử tài chính nội bộ: tiền vi-VN "đ", ngày
// dd/mm/yyyy giờ Việt Nam, Có/Không, trống là "—". Không sửa
// audit-logs/audit-diff.utils.ts: nhãn trường tài chính nằm ở đây.

export const EMPTY_VALUE = '—';
const MAX_STRING = 2000;
const MAX_DISPLAY = 300;
const MAX_DEPTH = 8;
const MAX_ARRAY = 500;

const NUMBER_FORMAT = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 4,
});
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

function isBlank(value: unknown): value is null | undefined | '' {
  return value === null || value === undefined || value === '';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (Prisma.Decimal.isDecimal(value)) return Number(value.toString());
  if (typeof value === 'string' && NUMERIC_TEXT.test(value.trim()))
    return Number(value.trim());
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function cap(text: string, max = MAX_DISPLAY) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 1250000 → "1.250.000 đ"; trống → "—". */
export function formatMoney(value: unknown): string {
  if (isBlank(value)) return EMPTY_VALUE;
  const amount = toNumber(value);
  if (amount === null) return String(value as string);
  return `${NUMBER_FORMAT.format(amount)} đ`;
}

/** Số lượng/km/lít theo vi-VN; trống → "—". */
export function formatNumber(value: unknown): string {
  if (isBlank(value)) return EMPTY_VALUE;
  const amount = toNumber(value);
  return amount === null
    ? String(value as string)
    : NUMBER_FORMAT.format(amount);
}

/** Ngày dd/mm/yyyy theo giờ Việt Nam; trống/không hợp lệ → "—". */
export function formatDate(value: unknown): string {
  if (isBlank(value)) return EMPTY_VALUE;
  const date = toDate(value);
  return date ? DATE_FORMAT.format(date) : EMPTY_VALUE;
}

export function formatBoolean(value: unknown): string {
  if (isBlank(value)) return EMPTY_VALUE;
  return value ? 'Có' : 'Không';
}

/** Lý do nối sau câu: ": <lý do>" hoặc chuỗi rỗng. */
export function reasonSuffix(reason?: string | null): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  return text ? `: ${text}` : '';
}

/** Rút gọn nội dung ghi chú cho câu lịch sử. */
export function previewText(text?: string | null, max = 80): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return cap(flat, max);
}

// ---- Nhãn ----

const ENTRY_KIND_LABELS: Record<string, string> = {
  DELIVERY_FEE: 'phiếu phí giao hàng',
  FUEL: 'phiếu xăng dầu',
  VEHICLE_CARE: 'phiếu chăm sóc xe',
  OTHER_EXPENSE: 'phiếu chi kho',
  CUSTOMER_RECEIPT: 'phiếu thu tiền mặt',
  MANUAL_RECEIPT: 'phiếu thu tiền mặt',
  SALARY_ADVANCE: 'tạm ứng lương',
  CASH_FUND_EXPENSE: 'phiếu chi quỹ',
  CASH_FUND_RECEIPT: 'phiếu thu quỹ',
};

/** Tên loại phiếu theo category của InternalFinanceEntry. */
export function entryKindLabel(category?: string | null): string {
  return (category && ENTRY_KIND_LABELS[category]) || 'phiếu';
}

const ROLE_LABELS: Record<string, string> = {
  MANAGER: 'Quản lý kho',
  ACCOUNTANT: 'Kế toán kho',
};

/** 'manager' | 'MANAGER' → "Quản lý kho"; 'accountant' → "Kế toán kho". */
export function reviewRoleLabel(role?: string | null): string {
  return (role && ROLE_LABELS[role.toUpperCase()]) || role || '';
}

const DECISION_LABELS: Record<string, string> = {
  APPROVE: 'duyệt',
  REJECT: 'từ chối',
  MARK_MISSING: 'đánh dấu thiếu chứng từ',
  EXCEPTION_APPROVE: 'duyệt ngoại lệ',
  CANCEL: 'hủy',
  UNCHECK: 'bỏ tick',
  REOPEN: 'mở lại',
  CONFIRM_AMOUNT: 'xác nhận thực nhận',
  CLEAR_CONFIRM: 'bỏ xác nhận thực nhận',
};

export function reviewDecisionLabel(decision?: string | null): string {
  return (
    (decision && DECISION_LABELS[decision.toUpperCase()]) || decision || ''
  );
}

export const ENTRY_STATUS_LABELS: Record<string, string> = {
  PENDING_ACCOUNTANT: 'Chờ kiểm tra',
  ACCOUNTANT_APPROVED: 'Kế toán đã duyệt',
  PENDING_MANAGER: 'Chờ quản lý',
  MANAGER_APPROVED: 'Đã kiểm tra',
  READY_FOR_WEEKLY_APPROVAL: 'Đã gom tuần',
  IN_WEEKLY_APPROVAL: 'Đang duyệt tuần',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  POSTING: 'Đang ghi sổ',
  POSTED: 'Đã ghi sổ',
  CANCELLED: 'Đã hủy',
};

export const BATCH_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Bản nháp',
  READY: 'Sẵn sàng tạo Approval',
  IN_APPROVAL: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  POSTED: 'Đã xử lý',
  CANCELLED: 'Đã hủy',
};

export const FUND_TXN_STATUS_LABELS: Record<string, string> = {
  POSTED: 'Đã ghi quỹ',
  CANCELLED: 'Đã hủy',
};

export const FUND_TRANSFER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chờ duyệt',
  IN_APPROVAL: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  POSTED: 'Đã ghi quỹ',
  REJECTED: 'Từ chối',
  CANCELLED: 'Đã hủy',
};

export const CLOSING_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Cần đối soát',
  MATCHED: 'Khớp',
  MISMATCHED: 'Lệch quỹ',
};

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  CANCELED: 'Đã hủy',
  DELETED: 'Đã xóa',
  REVERTED: 'Đã thu hồi',
  CREATE_FAILED: 'Tạo thất bại',
};

export const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  COMPLETE: 'Đủ chứng từ',
  MISSING: 'Thiếu chứng từ',
  EXCEPTION_APPROVED: 'Duyệt ngoại lệ',
};

export const FUEL_ADVANCE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Đang tính',
  CANCELLED: 'Đã hủy',
};

const STATUS_LABELS_BY_ENTITY: Partial<
  Record<FinanceAuditEntityType, Record<string, string>>
> = {
  [FINANCE_AUDIT_ENTITY.ENTRY]: ENTRY_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.BATCH]: BATCH_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.FUND_TXN]: FUND_TXN_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.FUND_TRANSFER]: FUND_TRANSFER_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.FUND_CLOSING]: CLOSING_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.APPROVAL]: APPROVAL_STATUS_LABELS,
  [FINANCE_AUDIT_ENTITY.FUEL_ADVANCE]: FUEL_ADVANCE_STATUS_LABELS,
};

/** Nhãn trạng thái theo loại bản ghi; mã lạ giữ nguyên. */
export function statusLabel(
  entityType: FinanceAuditEntityType,
  status?: string | null,
): string {
  if (isBlank(status)) return EMPTY_VALUE;
  return STATUS_LABELS_BY_ENTITY[entityType]?.[status] || status;
}

export const entryStatusLabel = (status?: string | null) =>
  statusLabel(FINANCE_AUDIT_ENTITY.ENTRY, status);
export const batchStatusLabel = (status?: string | null) =>
  statusLabel(FINANCE_AUDIT_ENTITY.BATCH, status);
export const fundTransferStatusLabel = (status?: string | null) =>
  statusLabel(FINANCE_AUDIT_ENTITY.FUND_TRANSFER, status);
export const approvalStatusLabel = (status?: string | null) =>
  statusLabel(FINANCE_AUDIT_ENTITY.APPROVAL, status);

const FUND_TXN_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'thu',
  EXPENSE: 'chi',
  TRANSFER_IN: 'nhận chuyển quỹ',
  TRANSFER_OUT: 'chuyển quỹ đi',
};

export function fundTxnTypeLabel(type?: string | null): string {
  return (type && FUND_TXN_TYPE_LABELS[type]) || type || '';
}

const FUND_SOURCE_LABELS: Record<string, string> = {
  INTERNAL_FINANCE_ENTRY: 'phiếu chi',
  WAREHOUSE_CASH_RECEIPT: 'tiền mặt kho',
  SEPAY_VPSG: 'Biến động số dư VPSG',
  BALANCE_ADJUSTMENT: 'cân bằng quỹ',
  LARK_PAYMENT_VOUCHER: 'đơn PHIẾU CHI Lark',
  LARK_SALARY_ADVANCE: 'đơn TẠM ỨNG LƯƠNG Lark',
  LEDGER_HISTORY: 'sổ quỹ cũ',
  INTERNAL_FUND_TRANSFER: 'chuyển quỹ',
  INTERNAL_FUND_RECEIPT: 'phiếu thu quỹ (Approval)',
};

export function fundSourceLabel(sourceType?: string | null): string {
  return (sourceType && FUND_SOURCE_LABELS[sourceType]) || sourceType || '';
}

const APPROVAL_KIND_LABELS: Record<string, string> = {
  EXPENSE_HN: 'chi Kho HN',
  EXPENSE_SG: 'chi Kho SG',
  EXPENSE_VP: 'chi văn phòng',
  RECEIPT: 'thu quỹ',
  TRANSFER: 'chuyển quỹ',
  PAYMENT_VOUCHER: 'PHIẾU CHI',
  SALARY_ADVANCE: 'TẠM ỨNG LƯƠNG',
  ADVANCE: 'tạm ứng',
};

export function approvalKindLabel(kind?: string | null): string {
  return (kind && APPROVAL_KIND_LABELS[kind]) || kind || '';
}

/** Trường của đơn Approval cần để ra mã hiển thị / tìm kiếm trong lịch sử. */
export interface ApprovalAuditRefRow {
  id: number;
  kind?: string | null;
  sourceType?: string | null;
  instanceCode?: string | null;
  clientUuid?: string | null;
  formSnapshot?: unknown;
  detailSnapshot?: unknown;
}

/** Số đơn Lark (serial_number) nếu đã biết. */
export function approvalSerial(request: ApprovalAuditRefRow): string | null {
  const detail = request.detailSnapshot as { serial_number?: unknown } | null;
  const metadata = (
    request.formSnapshot as { metadata?: { serialNumber?: unknown } } | null
  )?.metadata;
  const serial = detail?.serial_number ?? metadata?.serialNumber;
  return serial ? String(serial as string) : null;
}

/**
 * Mã hiển thị (số đơn Lark, chưa có thì #id), mã tìm kiếm và tên loại đơn —
 * dùng chung cho mọi dòng lịch sử của một đơn Approval.
 */
export function approvalAuditRef(request: ApprovalAuditRefRow) {
  const serial = approvalSerial(request);
  return {
    code: serial || `#${request.id}`,
    entityCode: serial || request.instanceCode || request.clientUuid || null,
    kindLabel:
      request.sourceType === 'INTERNAL_FUND_TRANSFER'
        ? approvalKindLabel('TRANSFER')
        : approvalKindLabel(request.kind),
  };
}

const BRANCH_LABELS: Record<number, string> = {
  6: 'Kho HN',
  1: 'Kho SG',
  4: 'Văn phòng HN',
  7: 'Văn phòng SG',
};

export function branchLabel(branchId?: number | string | null): string {
  if (isBlank(branchId)) return EMPTY_VALUE;
  return BRANCH_LABELS[Number(branchId)] || `Chi nhánh #${branchId}`;
}

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  CAR: 'Ô tô',
  MOTORBIKE: 'Xe máy',
};
const FUEL_TYPE_LABELS: Record<string, string> = {
  GASOLINE: 'Xăng',
  DIESEL: 'Dầu',
};
const RECEIPT_KIND_LABELS: Record<string, string> = {
  CUSTOMER: 'Thu khách',
  WAREHOUSE_SALE: 'Bán đồ kho',
};

// ---- Diff ----

const COMMON_LABELS: Record<string, string> = {
  amount: 'Số tiền',
  occurredAt: 'Ngày',
  description: 'Nội dung',
  note: 'Ghi chú',
  notes: 'Ghi chú',
  status: 'Trạng thái',
  branchId: 'Chi nhánh',
  cancelReason: 'Lý do hủy',
};

/** Nhãn tiếng Việt của các trường được so sánh, theo loại bản ghi. */
export const FINANCE_FIELD_LABELS: Record<
  FinanceAuditEntityType | 'common',
  Record<string, string>
> = {
  common: COMMON_LABELS,
  [FINANCE_AUDIT_ENTITY.ENTRY]: {
    amount: 'Số tiền',
    occurredAt: 'Ngày',
    description: 'Nội dung',
    note: 'Ghi chú',
    payerId: 'Người chi',
    expenseItem: 'Khoản mục',
    quantity: 'Số lượng',
    unitPrice: 'Đơn giá',
    // vehicleId không so sánh: đổi xe luôn đổi vehicleName (nhãn xe duy nhất
    // trong chi nhánh), tránh dòng "#id" người dùng không đọc được.
    vehicleName: 'Xe',
    vehicleOdo: 'Số km (ODO)',
    vehicleLiters: 'Số lít',
    vehicleUnitPrice: 'Đơn giá nhiên liệu',
    vehicleLocation: 'Địa điểm',
    vehicleServiceTypes: 'Hạng mục chăm sóc xe',
    vehicleDueAt: 'Hạn chăm sóc tiếp',
    // write() đổi id khách hàng thành "mã – tên".
    customerId: 'Khách hàng',
    // Phiếu Tiền mặt kho: danh sách khách (sourceSnapshot.customerIds) và loại
    // phiếu; người gọi tự đưa vào object so sánh.
    customerIds: 'Khách hàng',
    receiptKind: 'Loại phiếu',
    status: 'Trạng thái',
    confirmedAmount: 'Số thực nhận',
    branchId: 'Chi nhánh',
    evidenceStatus: 'Chứng từ',
    cancelReason: 'Lý do hủy',
  },
  [FINANCE_AUDIT_ENTITY.BATCH]: {
    status: 'Trạng thái',
    totalAmount: 'Tổng tiền',
    cancelReason: 'Lý do hủy',
  },
  [FINANCE_AUDIT_ENTITY.FUND_TXN]: {
    amount: 'Số tiền',
    occurredAt: 'Ngày ghi quỹ',
    description: 'Nội dung',
    status: 'Trạng thái',
    branchId: 'Quỹ',
  },
  [FINANCE_AUDIT_ENTITY.FUND_TRANSFER]: {
    status: 'Trạng thái',
    amount: 'Số tiền',
  },
  [FINANCE_AUDIT_ENTITY.FUND_CLOSING]: {
    actualOpeningBalance: 'Tồn đầu thực tế',
    actualReceipt: 'Thu thực tế',
    actualExpense: 'Chi thực tế',
    actualClosingBalance: 'Tồn cuối thực tế',
    notes: 'Ghi chú',
    reconciliationStatus: 'Đối soát',
  },
  [FINANCE_AUDIT_ENTITY.APPROVAL]: {
    status: 'Trạng thái',
  },
  [FINANCE_AUDIT_ENTITY.VEHICLE]: {
    label: 'Tên xe',
    plate: 'Biển số',
    vehicleType: 'Loại xe',
    fuelType: 'Nhiên liệu',
    isActive: 'Đang dùng',
    branchId: 'Chi nhánh',
    driverId: 'Tài xế',
    costPerKmMin: 'Định mức tối thiểu/km',
    costPerKmMax: 'Định mức tối đa/km',
    fuelNorm: 'Định mức (L/100km)',
    oilChangeIntervalKm: 'Thay dầu sau (km)',
    note: 'Ghi chú',
  },
  [FINANCE_AUDIT_ENTITY.FUEL_ADVANCE]: {
    amount: 'Số tiền',
    occurredAt: 'Ngày',
    note: 'Ghi chú',
    status: 'Trạng thái',
  },
  [FINANCE_AUDIT_ENTITY.SEPAY]: {},
  [FINANCE_AUDIT_ENTITY.SCRIPT]: {},
};

/** Trường so sánh mặc định của diff() theo loại bản ghi (whitelist). */
export const FINANCE_DIFF_FIELDS: Record<
  FinanceAuditEntityType,
  readonly string[]
> = Object.fromEntries(
  (Object.keys(FINANCE_FIELD_LABELS) as (FinanceAuditEntityType | 'common')[])
    .filter((key) => key !== 'common')
    .map((key) => [key, Object.keys(FINANCE_FIELD_LABELS[key])]),
) as unknown as Record<FinanceAuditEntityType, readonly string[]>;

const MONEY_FIELDS = new Set([
  'amount',
  'confirmedAmount',
  'unitPrice',
  'vehicleUnitPrice',
  'totalAmount',
  'costPerKmMin',
  'costPerKmMax',
  'actualOpeningBalance',
  'actualReceipt',
  'actualExpense',
  'actualClosingBalance',
]);
const NUMBER_FIELDS = new Set([
  'quantity',
  'vehicleOdo',
  'vehicleLiters',
  'oilChangeIntervalKm',
  'fuelNorm',
]);
const DATE_FIELDS = new Set(['occurredAt', 'vehicleDueAt']);

/** Trường giữ User.id: write() đổi "#id" thành tên người dùng. */
export const FINANCE_USER_ID_FIELDS: ReadonlySet<string> = new Set([
  'payerId',
  'driverId',
]);

/** Trường giữ Customer.id (một id hoặc mảng): write() đổi thành "mã – tên". */
export const FINANCE_CUSTOMER_ID_FIELDS: ReadonlySet<string> = new Set([
  'customerId',
  'customerIds',
]);

/** Trường thay đổi hóa đơn liên kết: write() đổi "#invoiceId" thành mã HĐ. */
export const FINANCE_INVOICE_LINK_FIELD = 'invoiceLinks';

export function fieldLabel(
  entityType: FinanceAuditEntityType,
  field: string,
): string {
  return (
    FINANCE_FIELD_LABELS[entityType]?.[field] || COMMON_LABELS[field] || field
  );
}

/** Chuỗi hiển thị một giá trị trường (dùng cho from/to của changes). */
export function formatFieldValue(
  entityType: FinanceAuditEntityType,
  field: string,
  value: unknown,
): string {
  if (isBlank(value)) return EMPTY_VALUE;
  if (Array.isArray(value)) {
    const items = value.filter((item) => !isBlank(item));
    const idList = FINANCE_CUSTOMER_ID_FIELDS.has(field);
    return items.length
      ? cap(
          items
            .map((item) => (idList ? `#${scalarText(item)}` : scalarText(item)))
            .join(', '),
        )
      : EMPTY_VALUE;
  }
  if (MONEY_FIELDS.has(field)) return formatMoney(value);
  if (NUMBER_FIELDS.has(field)) return formatNumber(value);
  if (DATE_FIELDS.has(field) || value instanceof Date) return formatDate(value);
  if (typeof value === 'boolean') return formatBoolean(value);
  if (field === 'status') return statusLabel(entityType, scalarText(value));
  if (field === 'evidenceStatus')
    return EVIDENCE_STATUS_LABELS[scalarText(value)] || scalarText(value);
  if (field === 'reconciliationStatus')
    return CLOSING_STATUS_LABELS[scalarText(value)] || scalarText(value);
  if (field === 'branchId') return branchLabel(scalarText(value));
  if (field === 'vehicleType')
    return VEHICLE_TYPE_LABELS[scalarText(value)] || scalarText(value);
  if (field === 'fuelType')
    return FUEL_TYPE_LABELS[scalarText(value)] || scalarText(value);
  if (field === 'receiptKind')
    return RECEIPT_KIND_LABELS[scalarText(value)] || scalarText(value);
  if (FINANCE_USER_ID_FIELDS.has(field) || /Id$/.test(field))
    return `#${scalarText(value)}`;
  return cap(scalarText(value));
}

function scalarText(value: unknown): string {
  if (isBlank(value)) return '';
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object')
    return JSON.stringify(sanitizeAuditJson(value));
  return String(value as string | number | boolean | bigint);
}

/** Khóa so sánh: Decimal/số/chuỗi số cùng giá trị là bằng nhau, ngày theo mốc. */
function comparable(field: string, value: unknown): string | null {
  if (isBlank(value)) return null;
  if (Array.isArray(value)) return JSON.stringify(sanitizeAuditJson(value));
  if (value instanceof Date || DATE_FIELDS.has(field)) {
    const date = toDate(value);
    if (date) return `d:${date.getTime()}`;
  }
  const amount = toNumber(value);
  if (
    amount !== null &&
    (MONEY_FIELDS.has(field) ||
      NUMBER_FIELDS.has(field) ||
      typeof value !== 'string')
  )
    return `n:${amount}`;
  if (typeof value === 'boolean') return `b:${value}`;
  return `s:${scalarText(value)}`;
}

/**
 * So sánh trước/sau theo whitelist; trường không có ở CẢ hai object thì bỏ qua
 * (truyền dòng DB trước và sau khi sửa). Không có gì đổi → [].
 */
export function buildFinanceDiff(
  entityType: FinanceAuditEntityType,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): FinanceAuditChange[] {
  const keys = fields ?? FINANCE_DIFF_FIELDS[entityType] ?? [];
  const changes: FinanceAuditChange[] = [];
  for (const field of keys) {
    if (!(field in before) || !(field in after)) continue;
    const from = before[field];
    const to = after[field];
    if (comparable(field, from) === comparable(field, to)) continue;
    changes.push({
      field,
      label: fieldLabel(entityType, field),
      from: formatFieldValue(entityType, field, from),
      to: formatFieldValue(entityType, field, to),
      type: 'field_changed',
      detail: sanitizeAuditJson({ from: from ?? null, to: to ?? null }),
    });
  }
  return changes;
}

// ---- Câu lịch sử ----

function formatParam(key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return '';
  if (/amount|total/i.test(key)) {
    const amount = toNumber(value);
    if (amount !== null) return formatMoney(amount);
  }
  return String(value);
}

/** Thay MỌI {param}; tiền (khóa có amount/total) theo vi-VN "đ"; thiếu → ''. */
export function renderFinanceTemplate(
  template: string,
  params: FinanceAuditParams = {},
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    formatParam(key, params[key]),
  );
}

export function renderFinanceMessage(
  action: FinanceAuditAction,
  params: FinanceAuditParams = {},
): string {
  return cap(
    renderFinanceTemplate(FINANCE_AUDIT_CATALOG[action].template, params),
    MAX_STRING,
  );
}

// ---- JSON an toàn cho cột Json ----

/**
 * Decimal → number, Date → ISO, BigInt → chuỗi, bỏ undefined/hàm, cắt chuỗi
 * dài; chống vòng lặp tham chiếu và cây quá sâu.
 */
export function sanitizeAuditJson(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet<object>());
}

function sanitize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING - 1)}…`
        : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (Prisma.Decimal.isDecimal(value)) return Number(value.toString());
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[…]';
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.slice(0, MAX_ARRAY).map((item) => {
        const next = sanitize(item, depth + 1, seen);
        return next === undefined ? null : next;
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const next = sanitize(item, depth + 1, seen);
      if (next !== undefined) result[key] = next;
    }
    return result;
  } finally {
    seen.delete(object);
  }
}
