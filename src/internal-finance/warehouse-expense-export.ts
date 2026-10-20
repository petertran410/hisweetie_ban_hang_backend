import { Prisma } from '@prisma/client';

/**
 * Xuất Excel trang Phiếu chi kho: nhãn và cách hiển thị chép từ bảng
 * (pos-hisweetie WarehouseExpenseTable + lib/internal-finance/display.ts)
 * để file khớp những gì người dùng thấy.
 */

const SOURCE_LABELS: Record<string, string> = {
  PACKING_SLIP: 'Báo đơn giao hàng',
  MANUAL_RECEIPT: 'Phiếu thu thủ công',
  MANUAL_EXPENSE: 'Phiếu chi thủ công',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
  LARK_APPROVAL: 'Lark Approval',
};

// Phiếu chuyển từ hệ thống cũ không có nguồn riêng nên gọi tên theo loại khoản.
const CATEGORY_SOURCE_LABELS: Record<string, string> = {
  DELIVERY_FEE: 'Báo đơn giao hàng',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
  SALARY_ADVANCE: 'Tạm ứng lương',
  CUSTOMER_RECEIPT: 'Thu tiền khách',
  MANUAL_RECEIPT: 'Phiếu thu',
  OTHER_EXPENSE: 'Phiếu chi kho',
};

const CATEGORY_LABELS: Record<string, string> = {
  DELIVERY_FEE: 'Chi phí giao hàng',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
  OTHER_EXPENSE: 'Chi phí khác',
};

const SUBCATEGORY_LABELS: Record<string, string> = {
  FEE_GUI_BEN: 'Phí gửi bến',
  FEE_GRAB: 'Phí Grab',
  SHIPPING_OUT: 'Cước gửi hàng',
  SHIPPING_IN: 'Cước nhận hàng',
  FUEL: 'Xăng dầu',
  VEHICLE_CARE: 'Chăm sóc xe',
  OTHER: 'Chi phí khác',
};

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  CANCELED: 'Đã hủy',
  DELETED: 'Đã xóa',
  REVERTED: 'Đã thu hồi',
  CREATE_FAILED: 'Tạo thất bại',
};

// Mã loại phí cũ ghi thẳng vào nội dung phiếu (vd "FEE_GUI_BEN - BD-123").
const DESCRIPTION_CODE_LABELS: Record<string, string> = {
  FEE_GUI_BEN: 'Phí gửi bến',
  FEE_GRAB: 'Phí Grab',
  SHIPPING_OUT: 'Cước gửi hàng',
  SHIPPING_IN: 'Cước nhận hàng',
  DELIVERY_FEE: 'Chi phí giao hàng',
  OTHER_EXPENSE: 'Chi phí khác',
  VEHICLE_CARE: 'Chăm sóc xe',
  CUSTOMER_RECEIPT: 'Thu tiền khách',
};

// Phiếu chỉ nhập ngày (không có giờ): dữ liệu từ Lark, phiếu chi/thu tay.
const DATE_ONLY_SOURCES = [
  'LARK_IMPORT',
  'LARK_APPROVAL',
  'MANUAL_EXPENSE',
  'MANUAL_RECEIPT',
];
const BUSINESS_DATE_FIELDS = [
  'Năm-Tháng',
  'NĂM/THÁNG/NGÀY',
  'Ngày',
  'Ngày chi',
  'Ngày thu',
];
const WAREHOUSE_BRANCH_IDS = [6, 1];
const VN_OFFSET_MS = 7 * 3600 * 1000;

export const WAREHOUSE_EXPENSE_EXPORT_SELECT = {
  id: true,
  code: true,
  branchId: true,
  occurredAt: true,
  sourceType: true,
  sourceSnapshot: true,
  category: true,
  subCategory: true,
  description: true,
  note: true,
  expenseItem: true,
  quantity: true,
  unitPrice: true,
  amount: true,
  status: true,
  cancelReason: true,
  cashIssued: true,
  cashIssuedReason: true,
  vehicleName: true,
  managerReviewedAt: true,
  accountantReviewedAt: true,
  branch: { select: { name: true } },
  payer: { select: { name: true } },
  creator: { select: { name: true } },
  managerReviewer: { select: { name: true } },
  accountantReviewer: { select: { name: true } },
  vehicle: { select: { label: true } },
  packingSlip: { select: { code: true } },
  fundTransaction: { select: { code: true, status: true } },
  weeklyBatch: {
    select: { code: true, approvalRequest: { select: { status: true } } },
  },
  attachments: {
    select: { fileUrl: true, fileName: true },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.InternalFinanceEntrySelect;

export type WarehouseExpenseExportEntry =
  Prisma.InternalFinanceEntryGetPayload<{
    select: typeof WAREHOUSE_EXPENSE_EXPORT_SELECT;
  }>;

export interface ExportLink {
  text: string;
  hyperlink: string;
}

export function warehouseExpenseExportColumns(attachmentColumns: number) {
  return [
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Mã phiếu', key: 'code', width: 30 },
    { header: 'Ngày chi', key: 'date', width: 17 },
    { header: 'Chi nhánh', key: 'branch', width: 14 },
    { header: 'Nguồn', key: 'source', width: 18 },
    { header: 'Mã báo đơn / Xe', key: 'reference', width: 20 },
    { header: 'Nội dung', key: 'description', width: 50 },
    { header: 'Ghi chú', key: 'note', width: 30 },
    { header: 'Khoản mục', key: 'item', width: 24 },
    { header: 'Nhóm phí', key: 'group', width: 18 },
    { header: 'Người chi', key: 'payer', width: 20 },
    { header: 'Người tạo', key: 'creator', width: 20 },
    { header: 'Số lượng', key: 'quantity', width: 10 },
    { header: 'Đơn giá', key: 'unitPrice', width: 13 },
    { header: 'Số tiền', key: 'amount', width: 14 },
    { header: 'Số chứng từ', key: 'attachmentCount', width: 11 },
    { header: 'Quản lý kho', key: 'manager', width: 30 },
    { header: 'Kế toán kho', key: 'accountant', width: 30 },
    { header: 'Batch Approval', key: 'batch', width: 34 },
    { header: 'Trạng thái duyệt', key: 'approvalStatus', width: 16 },
    { header: 'Đã chi', key: 'cashIssued', width: 10 },
    { header: 'Mã giao dịch quỹ', key: 'fundCode', width: 22 },
    { header: 'Lý do đã chi', key: 'cashIssuedReason', width: 30 },
    { header: 'Hủy phiếu', key: 'cancelled', width: 30 },
    ...Array.from({ length: attachmentColumns }, (_, index) => ({
      header: `Chứng từ ${index + 1}`,
      key: `file${index + 1}`,
      width: 24,
    })),
  ];
}

export function warehouseExpenseExportRow(
  entry: WarehouseExpenseExportEntry,
  stt: number,
) {
  const snapshot = asRecord(entry.sourceSnapshot);
  const group =
    SUBCATEGORY_LABELS[entry.subCategory || ''] ||
    CATEGORY_LABELS[entry.category] ||
    entry.category;
  const date = exportDate(entry);
  const approvalStatus = entry.weeklyBatch?.approvalRequest?.status;
  const fund = entry.fundTransaction;
  const row: Record<string, unknown> = {
    stt,
    code: entry.code,
    date: date.value,
    branch: entry.branch?.name || '',
    source:
      SOURCE_LABELS[entry.sourceType] ||
      CATEGORY_SOURCE_LABELS[entry.category] ||
      'Phiếu chi kho',
    reference:
      entry.packingSlip?.code ||
      entry.vehicle?.label ||
      entry.vehicleName ||
      (snapshot?.vehicle ? String(snapshot.vehicle) : ''),
    description: displayDescription(entry.description),
    note: entry.note || '',
    item: entry.expenseItem || group,
    group,
    payer: entry.payer?.name || '',
    creator: entry.creator?.name || '',
    quantity: entry.quantity != null ? Number(entry.quantity) : '',
    unitPrice: entry.unitPrice != null ? Number(entry.unitPrice) : '',
    amount: Number(entry.amount),
    attachmentCount: entry.attachments.length,
    manager: checkLabel(
      entry.branchId,
      entry.managerReviewer?.name,
      entry.managerReviewedAt,
    ),
    accountant: checkLabel(
      entry.branchId,
      entry.accountantReviewer?.name,
      entry.accountantReviewedAt,
    ),
    batch: entry.weeklyBatch?.code || 'Chưa tổng hợp',
    approvalStatus: approvalStatus
      ? APPROVAL_STATUS_LABELS[approvalStatus] || approvalStatus
      : 'Chưa gửi',
    cashIssued: entry.cashIssued ? 'Đã chi' : 'Chưa chi',
    fundCode: fund?.code
      ? `${fund.code}${fund.status === 'CANCELLED' ? ' (đã hủy)' : ''}`
      : '',
    cashIssuedReason: entry.cashIssuedReason || '',
    cancelled:
      entry.status === 'CANCELLED'
        ? ['Đã hủy', entry.cancelReason].filter(Boolean).join(': ')
        : '',
  };
  entry.attachments.forEach((file, index) => {
    const link: ExportLink = {
      text:
        file.fileName || file.fileUrl.split('?')[0].split('/').pop() || 'Mở',
      hyperlink: file.fileUrl,
    };
    row[`file${index + 1}`] = link;
  });
  return { row, dateHasTime: date.hasTime };
}

/** Đổi mã loại phí cũ trong nội dung thành tên dễ đọc. */
export function displayDescription(text?: string | null) {
  if (!text) return '';
  return text.replace(
    /\b(FEE_GUI_BEN|FEE_GRAB|SHIPPING_OUT|SHIPPING_IN|DELIVERY_FEE|OTHER_EXPENSE|VEHICLE_CARE|CUSTOMER_RECEIPT)\b/g,
    (code) => DESCRIPTION_CODE_LABELS[code] || code,
  );
}

/**
 * Ngày chi như cột "Ngày chi" trên bảng: ưu tiên ngày nghiệp vụ trong dữ liệu
 * Lark, không có thì lấy giờ VN. Trả Date theo giờ VN (ghi vào Excel như giờ
 * địa phương) để Excel lọc, sắp xếp được.
 */
export function exportDate(entry: {
  occurredAt: Date;
  sourceType: string;
  sourceSnapshot: unknown;
}): { value: Date; hasTime: boolean } {
  const snapshot = asRecord(entry.sourceSnapshot);
  const business = businessDate(snapshot);
  if (business) return { value: business, hasTime: false };
  const local = new Date(new Date(entry.occurredAt).getTime() + VN_OFFSET_MS);
  const dateOnly =
    DATE_ONLY_SOURCES.includes(entry.sourceType) ||
    snapshot?.missingDate === true;
  if (dateOnly)
    return {
      value: new Date(
        Date.UTC(
          local.getUTCFullYear(),
          local.getUTCMonth(),
          local.getUTCDate(),
        ),
      ),
      hasTime: false,
    };
  return { value: local, hasTime: true };
}

function businessDate(snapshot: Record<string, unknown> | null): Date | null {
  const fields = asRecord(snapshot?.fields);
  if (!fields) return null;
  for (const key of BUSINESS_DATE_FIELDS) {
    const match = plainText(fields[key]).match(
      /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/,
    );
    if (!match) continue;
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return new Date(Date.UTC(year, month - 1, day));
  }
  return null;
}

function checkLabel(
  branchId: number,
  name: string | undefined,
  at: Date | null,
) {
  if (!WAREHOUSE_BRANCH_IDS.includes(branchId) || !at) return '';
  const time = new Date(at).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  return [name || 'Đã tick', time].join(' · ');
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainText).join(', ');
  const record = asRecord(value);
  if (record && 'text' in record) return plainText(record.text);
  if (record && 'name' in record) return plainText(record.name);
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
