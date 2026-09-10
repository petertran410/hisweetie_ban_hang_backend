export type CustomerDemandImportUnit = 'BASE' | 'CARTON';

export interface CustomerDemandImportRawRow {
  row: number;
  customerCode: string;
  customerName: string;
  productCode: string;
  productName: string;
  monthRaw: string;
  quantityRaw: string;
  unitRaw: string;
  note: string;
}

export interface CustomerDemandImportParsedRow extends CustomerDemandImportRawRow {
  month: string | null;
  quantity: number | null;
  unit: CustomerDemandImportUnit;
  errors: string[];
}

export interface CustomerDemandImportLine {
  productId: number;
  productCode: string;
  productName: string;
  quantity: number;
  unit: CustomerDemandImportUnit;
  quantityBase: number;
  conversionValue: number;
}

export interface CustomerDemandImportMonth {
  month: string;
  lines: CustomerDemandImportLine[];
}

export interface CustomerDemandImportGroup {
  customerId: number;
  customerCode: string;
  customerName: string;
  note?: string;
  months: CustomerDemandImportMonth[];
}

export function normalizeImportHeader(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

export function parseImportQuantity(value: string): number | null {
  const trimmed = String(value ?? '').trim().replace(/\s/g, '');
  if (!trimmed) return null;
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  let normalized = trimmed;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? trimmed.replace(/\./g, '').replace(',', '.')
        : trimmed.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = trimmed.length - lastComma - 1;
    normalized =
      decimals <= 2 ? trimmed.replace(',', '.') : trimmed.replace(/,/g, '');
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function parseImportUnit(value: string): CustomerDemandImportUnit | null {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return 'BASE';
  if (
    [
      'base',
      'don vi',
      'don vi co ban',
      'dv',
      'dvcb',
      'goi',
      'unit',
    ].includes(normalized)
  ) {
    return 'BASE';
  }
  if (['carton', 'thung', 'thung carton', 'box'].includes(normalized)) {
    return 'CARTON';
  }
  return null;
}

export function parseImportMonth(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatYearMonth(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 20000 && value < 100000) {
      return formatYearMonth(excelSerialToDate(value));
    }
    const asText = String(Math.trunc(value));
    if (/^\d{6}$/.test(asText)) {
      return parseYearMonthText(`${asText.slice(0, 4)}-${asText.slice(4)}`);
    }
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseYearMonthText(text);
}

export function validateImportRow(
  row: CustomerDemandImportRawRow,
): CustomerDemandImportParsedRow {
  const errors: string[] = [];
  if (!row.customerCode) errors.push('Thiếu mã khách hàng');
  if (!row.productCode) errors.push('Thiếu mã sản phẩm');

  const month = parseImportMonth(row.monthRaw);
  if (!month) errors.push('Tháng cần hàng phải có dạng YYYY-MM');

  const quantity = parseImportQuantity(row.quantityRaw);
  if (quantity == null) errors.push('Số lượng không hợp lệ');
  else if (quantity <= 0) errors.push('Số lượng phải lớn hơn 0');

  const unit = parseImportUnit(row.unitRaw);
  if (!unit) {
    errors.push('Đơn vị chỉ nhận Đơn vị cơ bản hoặc Thùng');
  }

  return {
    ...row,
    month,
    quantity,
    unit: unit ?? 'BASE',
    errors,
  };
}

export function groupCustomerDemandImportRows(
  rows: Array<
    CustomerDemandImportParsedRow & {
      customerId?: number | null;
      customerNameResolved?: string | null;
      productId?: number | null;
      productNameResolved?: string | null;
      quantityBase?: number | null;
      conversionValue?: number | null;
    }
  >,
): CustomerDemandImportGroup[] {
  const groups = new Map<
    number,
    CustomerDemandImportGroup & { monthMap: Map<string, Map<number, CustomerDemandImportLine>> }
  >();

  for (const row of rows) {
    if (row.errors.length) continue;
    if (
      !row.customerId ||
      !row.productId ||
      !row.month ||
      row.quantity == null ||
      row.quantityBase == null ||
      row.conversionValue == null
    ) {
      continue;
    }

    let group = groups.get(row.customerId);
    if (!group) {
      group = {
        customerId: row.customerId,
        customerCode: row.customerCode,
        customerName: row.customerNameResolved || row.customerName || row.customerCode,
        note: row.note || undefined,
        months: [],
        monthMap: new Map(),
      };
      groups.set(row.customerId, group);
    } else if (!group.note && row.note) {
      group.note = row.note;
    }

    let productMap = group.monthMap.get(row.month);
    if (!productMap) {
      productMap = new Map();
      group.monthMap.set(row.month, productMap);
    }

    if (productMap.has(row.productId)) {
      row.errors.push(
        `Trùng sản phẩm ${row.productCode} trong tháng ${row.month} của cùng khách hàng`,
      );
      continue;
    }

    productMap.set(row.productId, {
      productId: row.productId,
      productCode: row.productCode,
      productName: row.productNameResolved || row.productName || row.productCode,
      quantity: row.quantity,
      unit: row.unit,
      quantityBase: row.quantityBase,
      conversionValue: row.conversionValue,
    });
  }

  return [...groups.values()].map((group) => ({
    customerId: group.customerId,
    customerCode: group.customerCode,
    customerName: group.customerName,
    note: group.note,
    months: [...group.monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, lines]) => ({
        month,
        lines: [...lines.values()],
      })),
  }));
}

function parseYearMonthText(text: string): string | null {
  const value = text.trim();
  const iso = value.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/);
  if (iso) return toYearMonth(Number(iso[1]), Number(iso[2]));
  const vn = value.match(/^(\d{1,2})[-/](\d{4})$/);
  if (vn) return toYearMonth(Number(vn[2]), Number(vn[1]));
  return null;
}

function toYearMonth(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatYearMonth(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 7);
}

function excelSerialToDate(serial: number): Date {
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  return new Date(utc);
}
