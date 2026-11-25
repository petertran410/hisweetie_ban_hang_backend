import { Prisma } from '@prisma/client';
import { activeAttachments } from './entry-files';
import { isFuelAdvanceEntry } from './fuel-advance';
import { INTERNAL_FINANCE_CATEGORY } from './internal-finance.constants';
import type { FuelMetrics } from '../vehicles/vehicle-metrics';
import { FUEL_NORM_TOLERANCE } from '../vehicles/vehicles.constants';
import type { ExportLink } from './warehouse-expense-export';

/**
 * Xuất Excel trang Xe cộ: nhãn và cách hiển thị chép từ bảng (pos-hisweetie
 * components/vehicles/VehicleEntryTable.tsx + lib/internal-finance/
 * vehicle-constants.ts) để file khớp những gì người dùng thấy.
 */

const STATUS_LABELS: Record<string, string> = {
  PENDING_ACCOUNTANT: 'Chờ kế toán',
  ACCOUNTANT_APPROVED: 'Kế toán đã duyệt',
  PENDING_MANAGER: 'Chờ quản lý',
  MANAGER_APPROVED: 'Quản lý đã duyệt',
  READY_FOR_WEEKLY_APPROVAL: 'Sẵn sàng tổng hợp',
  IN_WEEKLY_APPROVAL: 'Đang duyệt',
  APPROVED: 'Đã duyệt',
  POSTED: 'Đã ghi sổ',
  REJECTED: 'Từ chối',
  CANCELLED: 'Đã hủy',
};
const FUEL_ADVANCE_USED_LABEL = 'Trừ tiền ứng xăng';
const CHECK_TEXT: Record<string, string> = {
  NORMAL: 'Bình thường',
  ABNORMAL: 'Bất thường',
  UNSET: 'Chưa đặt',
};
const VN_OFFSET_MS = 7 * 3600 * 1000;

export const VEHICLE_ENTRY_EXPORT_SELECT = {
  id: true,
  code: true,
  branchId: true,
  category: true,
  occurredAt: true,
  amount: true,
  status: true,
  cancelReason: true,
  note: true,
  vehicleId: true,
  vehicleName: true,
  vehicleLocation: true,
  vehicleUnitPrice: true,
  vehicleLiters: true,
  vehicleOdo: true,
  vehicleDueAt: true,
  vehicleServiceType: true,
  vehicleServiceTypes: true,
  managerReviewedAt: true,
  accountantReviewedAt: true,
  branch: { select: { name: true } },
  creator: { select: { name: true } },
  payer: { select: { name: true } },
  vehicle: { select: { label: true } },
  weeklyBatch: { select: { code: true } },
  // Chỉ ảnh còn dùng (bỏ dòng đã gỡ).
  attachments: {
    ...activeAttachments,
    select: { fileUrl: true, fileName: true },
  },
} satisfies Prisma.InternalFinanceEntrySelect;

export type VehicleEntryExportEntry = Prisma.InternalFinanceEntryGetPayload<{
  select: typeof VEHICLE_ENTRY_EXPORT_SELECT;
}>;

type Column = { header: string; key: string; width: number };

/** Định dạng số theo key cột (ExcelJS numFmt). */
export const VEHICLE_ENTRY_NUMBER_FORMATS: Record<string, string> = {
  unitPrice: '#,##0',
  liters: '#,##0.00',
  amount: '#,##0',
  odo: '#,##0',
  prevOdo: '#,##0',
  nextOdo: '#,##0',
  km: '#,##0',
  costPerKm: '#,##0',
  litersPer100Km: '0.00',
  norm: '0.00',
};

export function vehicleEntryExportColumns(
  isFuel: boolean,
  attachmentColumns: number,
): Column[] {
  const head: Column[] = [
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Mã phiếu', key: 'code', width: 28 },
    { header: 'Thời gian', key: 'date', width: 17 },
    { header: 'Chi nhánh', key: 'branch', width: 14 },
    { header: 'Xe', key: 'vehicle', width: 24 },
  ];
  const body: Column[] = isFuel
    ? [
        { header: 'Lái xe', key: 'driver', width: 20 },
        { header: 'Địa điểm', key: 'location', width: 28 },
        { header: 'Đơn giá', key: 'unitPrice', width: 11 },
        { header: 'Số lít', key: 'liters', width: 10 },
        { header: 'Số tiền', key: 'amount', width: 13 },
        { header: 'ODO', key: 'odo', width: 11 },
        { header: 'ODO kỳ trước', key: 'prevOdo', width: 13 },
        { header: 'ODO kỳ sau', key: 'nextOdo', width: 13 },
        { header: 'Km trong kỳ', key: 'km', width: 12 },
        { header: 'đ/km', key: 'costPerKm', width: 10 },
        { header: 'l/100km', key: 'litersPer100Km', width: 10 },
        {
          header: `Định mức l/100km (±${FUEL_NORM_TOLERANCE})`,
          key: 'norm',
          width: 16,
        },
        { header: 'Kiểm tra', key: 'check', width: 34 },
        { header: 'Người chi', key: 'payer', width: 20 },
        { header: 'Ghi chú', key: 'note', width: 30 },
      ]
    : [
        { header: 'Loại dịch vụ', key: 'services', width: 30 },
        { header: 'Hạn ĐK / BH', key: 'dueAt', width: 13 },
        { header: 'ODO', key: 'odo', width: 11 },
        { header: 'Chi phí', key: 'amount', width: 13 },
        { header: 'Địa điểm', key: 'location', width: 28 },
        { header: 'Lái xe', key: 'driver', width: 20 },
        { header: 'Người chi', key: 'payer', width: 20 },
        { header: 'Ghi chú', key: 'note', width: 30 },
      ];
  return [
    ...head,
    ...body,
    { header: 'Trạng thái', key: 'status', width: 18 },
    { header: 'Lý do hủy', key: 'cancelReason', width: 28 },
    { header: 'Batch Approval', key: 'batch', width: 30 },
    { header: 'Số ảnh', key: 'attachmentCount', width: 8 },
    ...Array.from({ length: attachmentColumns }, (_, index) => ({
      header: `Ảnh ${index + 1}`,
      key: `file${index + 1}`,
      width: 24,
    })),
  ];
}

const numberOrBlank = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? ''
    : Number.isFinite(Number(value))
      ? Number(value)
      : '';

/** Giờ VN (ghi vào Excel như giờ địa phương) như cột "Thời gian" trên bảng. */
const vnDateTime = (value: Date) =>
  new Date(new Date(value).getTime() + VN_OFFSET_MS);

/** Ngày VN không có giờ, như cột "Hạn ĐK / BH". */
const vnDate = (value: Date) => {
  const local = vnDateTime(value);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );
};

/** Chữ cột "Kiểm tra", giống các nhãn CheckBadges trên bảng. */
export function vehicleCheckText(metrics?: FuelMetrics | null) {
  const parts: string[] = [];
  if (metrics?.odoCheck) parts.push('ODO: Bất thường');
  const consumption = metrics?.consumptionCheck
    ? metrics.consumptionCheck
    : metrics?.litersPer100Km != null && metrics.norm === null
      ? 'UNSET'
      : null;
  if (consumption) parts.push(`Định mức: ${CHECK_TEXT[consumption]}`);
  if (metrics?.costCheck) parts.push(`đ/km: ${CHECK_TEXT[metrics.costCheck]}`);
  if (parts.length) return parts.join('; ');
  return metrics?.nextOdo == null ? 'Chờ lần đổ sau' : 'Chưa đủ dữ liệu';
}

/** Chữ cột "Trạng thái": phiếu xăng Kho HN đủ 2 tick là "Trừ tiền ứng xăng". */
export function vehicleStatusText(entry: VehicleEntryExportEntry) {
  const fuelAdvanceUsed =
    isFuelAdvanceEntry(entry) &&
    Boolean(entry.managerReviewedAt && entry.accountantReviewedAt) &&
    !['CANCELLED', 'REJECTED'].includes(entry.status);
  return fuelAdvanceUsed
    ? FUEL_ADVANCE_USED_LABEL
    : STATUS_LABELS[entry.status] || entry.status;
}

export function vehicleEntryExportRow(
  entry: VehicleEntryExportEntry,
  stt: number,
  metrics?: FuelMetrics | null,
) {
  const isFuel = entry.category === INTERNAL_FINANCE_CATEGORY.FUEL;
  const services = entry.vehicleServiceTypes?.length
    ? entry.vehicleServiceTypes
    : (entry.vehicleServiceType || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  const row: Record<string, unknown> = {
    stt,
    code: entry.code,
    date: vnDateTime(entry.occurredAt),
    branch: entry.branch?.name || '',
    vehicle: entry.vehicle?.label || entry.vehicleName || '',
    driver: entry.creator?.name || '',
    location: entry.vehicleLocation || '',
    amount: Number(entry.amount),
    odo: numberOrBlank(entry.vehicleOdo),
    payer: entry.payer?.name || '',
    note: entry.note || '',
    status: vehicleStatusText(entry),
    cancelReason:
      entry.status === 'CANCELLED' ? entry.cancelReason || 'Đã hủy' : '',
    batch: entry.weeklyBatch?.code || '',
    attachmentCount: entry.attachments.length,
  };
  if (isFuel) {
    Object.assign(row, {
      unitPrice: numberOrBlank(entry.vehicleUnitPrice),
      liters: numberOrBlank(entry.vehicleLiters),
      prevOdo: numberOrBlank(metrics?.prevOdo),
      nextOdo: numberOrBlank(metrics?.nextOdo),
      km: numberOrBlank(metrics?.kmInPeriod),
      costPerKm: numberOrBlank(metrics?.costPerKm),
      litersPer100Km:
        metrics?.litersPer100Km != null
          ? Math.round(metrics.litersPer100Km * 100) / 100
          : '',
      norm: numberOrBlank(metrics?.norm),
      check: vehicleCheckText(metrics),
    });
  } else {
    Object.assign(row, {
      services: services.join(', '),
      dueAt: entry.vehicleDueAt ? vnDate(entry.vehicleDueAt) : '',
    });
  }
  entry.attachments.forEach((file, index) => {
    const link: ExportLink = {
      text:
        file.fileName || file.fileUrl.split('?')[0].split('/').pop() || 'Mở',
      hyperlink: file.fileUrl,
    };
    row[`file${index + 1}`] = link;
  });
  return row;
}

/** Một dòng sheet "Theo xe". */
export interface VehicleSummaryRow {
  vehicle: string;
  branch: string;
  count: number;
  amount: number;
  liters: number;
  /** Km và số lít của các kỳ đã tính được l/100km (mỗi lần đổ tính một lần). */
  km: number;
  kmLiters: number;
  norm: number | null;
  abnormal: number;
}

/**
 * Cộng dồn sheet "Theo xe" khi duyệt từng phiếu. Các phiếu cùng ODO dùng chung
 * một kỳ (cùng object metrics) nên km của kỳ đó chỉ cộng một lần.
 */
export function createVehicleSummary() {
  const rows = new Map<string, VehicleSummaryRow>();
  const countedPeriods = new Set<FuelMetrics>();
  return {
    add(entry: VehicleEntryExportEntry, metrics?: FuelMetrics | null) {
      const vehicle =
        entry.vehicle?.label || entry.vehicleName || '(Không rõ xe)';
      const key = `${entry.branchId}|${vehicle}`;
      const row = rows.get(key) || {
        vehicle,
        branch: entry.branch?.name || '',
        count: 0,
        amount: 0,
        liters: 0,
        km: 0,
        kmLiters: 0,
        norm: null,
        abnormal: 0,
      };
      row.count += 1;
      row.amount += Number(entry.amount);
      row.liters += Number(entry.vehicleLiters || 0);
      if (metrics) {
        row.norm = metrics.norm;
        if (vehicleCheckText(metrics).includes('Bất thường')) row.abnormal += 1;
        if (
          metrics.litersPer100Km != null &&
          metrics.kmInPeriod &&
          !countedPeriods.has(metrics)
        ) {
          countedPeriods.add(metrics);
          row.km += metrics.kmInPeriod;
          row.kmLiters += (metrics.litersPer100Km * metrics.kmInPeriod) / 100;
        }
      }
      rows.set(key, row);
    },
    rows: () =>
      Array.from(rows.values()).sort(
        (a, b) =>
          a.branch.localeCompare(b.branch) ||
          a.vehicle.localeCompare(b.vehicle),
      ),
  };
}
