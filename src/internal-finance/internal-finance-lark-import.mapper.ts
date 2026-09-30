import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_DIRECTION,
  INTERNAL_FINANCE_EVIDENCE_STATUS,
  INTERNAL_FINANCE_STATUS,
  INTERNAL_FINANCE_SUBCATEGORY,
} from './internal-finance.constants';

export const LARK_IMPORT_SOURCES = [
  'EXPENSE_HN',
  'EXPENSE_SG',
  'EXPENSE_VP',
  'RECEIPT',
  'SALARY_ADVANCE',
  'FUEL',
  'VEHICLE_CARE',
  'APPROVAL_HN',
  'APPROVAL_SG',
  'APPROVAL_VP',
] as const;

export type LarkImportSource = (typeof LARK_IMPORT_SOURCES)[number];

export const LARK_VEHICLE_BASE_FALLBACK = 'L0QqbLrGnaDW1csc8p0lieM3g9f';
export const LARK_APPROVAL_TABLE_FALLBACKS = {
  APPROVAL_HN: 'tbljYaWkP1tyBjTk',
  APPROVAL_SG: 'tble63nBiGQWE5Fs',
  APPROVAL_VP: 'tblTES6ldiMv6N2C',
} as const;

export const PROTECTED_IMPORT_STATUSES = new Set<string>([
  INTERNAL_FINANCE_STATUS.POSTED,
  INTERNAL_FINANCE_STATUS.POSTING,
  INTERNAL_FINANCE_STATUS.IN_WEEKLY_APPROVAL,
]);

const MONEY_FIELDS = ['Số tiền', 'Thành tiền', 'Tổng tiền'];
const UNIT_PRICE_FIELDS = ['ĐƠN GIÁ', 'Đơn giá'];
const QUANTITY_FIELDS = ['Số lượng'];
const DATE_FIELDS = [
  'Năm-Tháng',
  'NĂM/THÁNG/NGÀY',
  'Ngày',
  'Ngày chi',
  'Ngày thu',
  'Thời gian',
];
const CONTENT_FIELDS = [
  'NỘI DUNG',
  'Nội dung',
  'Nội dung thu',
  'Diễn giải',
  'Ghi chú',
];
const CATEGORY_FIELDS = ['Khoản Mục', 'Khoản mục', 'Khoản mục chi'];
const DEPARTMENT_FIELDS = ['Phòng ban', 'Chi nhánh'];
const SLIP_FIELDS = ['Mã Báo Đơn', 'Mã báo đơn'];
const PAYER_FIELDS = ['Người Chi', 'Người chi', 'Người nộp', 'Người nộp tiền'];
const CUSTOMER_FIELDS = [
  'Khách hàng',
  'Tên khách',
  'Người nộp',
  'Người nộp tiền',
];
const FILE_FIELDS = ['Chứng từ', 'Hóa đơn', 'Hình ảnh', 'Tệp đính kèm', 'File'];
const VEHICLE_FIELDS = ['Xe', 'Biển số', 'Phương tiện'];
const LOCATION_FIELDS = ['Địa điểm', 'Nơi đổ', 'Cây xăng'];
const ODO_FIELDS = ['ODO', 'Số km', 'Công tơ mét'];
const LITER_FIELDS = ['Số lít', 'Số lit'];
const LIMIT_FIELDS = ['Định mức', 'Định mức tiêu hao'];
const SERVICE_FIELDS = ['Loại dịch vụ', 'Dịch vụ'];
const ANOMALY_FIELDS = ['Bất thường', 'Ghi chú bất thường'];

export interface LarkTableRef {
  tableId: string;
  name: string;
}

export interface LarkAttachmentRef {
  fileToken: string;
  name?: string;
  type?: string;
  url?: string;
  tmpUrl?: string;
}

export interface LarkPersonRef {
  id: string | null;
  name: string | null;
}

export interface MappedLarkEntry {
  sourceKey: string;
  code: string;
  direction: string;
  category: string;
  subCategory: string;
  branchId: number;
  amount: number;
  occurredAt: Date | null;
  description: string | null;
  status: string;
  evidenceStatus: string;
  slipCode: string | null;
  customerName: string | null;
  invoiceCodes: string[];
  accountantTicked: boolean;
  managerTicked: boolean;
  cashIssued: boolean;
  larkCreator: LarkPersonRef | null;
  larkPayer: LarkPersonRef | null;
  larkAccountant: LarkPersonRef | null;
  larkManager: LarkPersonRef | null;
  attachments: LarkAttachmentRef[];
  sourceSnapshot: Record<string, unknown>;
}

export function normalizeLookup(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function classifyTable(
  name: string,
): LarkImportSource | 'ROLLUP' | null {
  const normalized = normalizeLookup(name);
  if (normalized.includes('giao dich tien mat')) return 'ROLLUP';
  if (normalized.includes('cham soc')) return 'VEHICLE_CARE';
  if (normalized.includes('xang')) return 'FUEL';
  if (normalized.includes('tam ung')) return 'SALARY_ADVANCE';
  if (normalized.includes('phieu thu') && !normalized.includes('phieu chi')) {
    return 'RECEIPT';
  }
  if (!normalized.includes('phieu chi')) return null;
  if (normalized.includes('van phong') || normalized.includes('vp')) {
    return 'EXPENSE_VP';
  }
  if (normalized.includes('ha noi') || /\bhn\b/.test(normalized)) {
    return 'EXPENSE_HN';
  }
  if (normalized.includes('sai gon') || /\bsg\b/.test(normalized)) {
    return 'EXPENSE_SG';
  }
  return null;
}

export function branchFromLabel(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const normalized = normalizeLookup(value);
  if (normalized.includes('van phong') || normalized.includes('vp')) {
    if (
      normalized.includes('ha noi') ||
      normalized.includes('vphn') ||
      /\bhn\b/.test(normalized)
    ) {
      return 4;
    }
    return 7;
  }
  if (normalized.includes('ha noi') || /\bhn\b/.test(normalized)) return 6;
  if (normalized.includes('sai gon') || /\bsg\b/.test(normalized)) return 1;
  return null;
}

export function defaultBranchForSource(
  source: LarkImportSource,
  tableName: string,
): number | null {
  if (source === 'EXPENSE_HN') return 6;
  if (source === 'EXPENSE_SG') return 1;
  if (source === 'EXPENSE_VP') return branchFromLabel(tableName) === 4 ? 4 : 7;
  if (source === 'APPROVAL_HN') return 6;
  if (source === 'APPROVAL_SG') return 1;
  if (source === 'APPROVAL_VP') return 7;
  return branchFromLabel(tableName);
}

export function selectTablesForSource(
  source: LarkImportSource,
  tables: LarkTableRef[],
  preferredTableId?: string | null,
): LarkTableRef[] {
  if (
    preferredTableId &&
    (source === 'EXPENSE_HN' ||
      source === 'EXPENSE_SG' ||
      source === 'APPROVAL_HN' ||
      source === 'APPROVAL_SG' ||
      source === 'APPROVAL_VP')
  ) {
    const known = tables.find((table) => table.tableId === preferredTableId);
    return [
      known || {
        tableId: preferredTableId,
        name:
          source === 'APPROVAL_HN'
            ? 'Approval PHIẾU CHI kho HN'
            : source === 'APPROVAL_SG'
              ? 'Approval PHIẾU CHI kho SG'
              : source === 'APPROVAL_VP'
                ? 'Approval PHIẾU CHI VPSG'
                : source === 'EXPENSE_HN'
                  ? 'Phiếu chi Kho HN'
                  : 'Phiếu chi Kho SG',
      },
    ];
  }
  return tables.filter((table) => classifyTable(table.name) === source);
}

export function requiredFieldError(
  fieldNames: string[],
  source: LarkImportSource,
): string | null {
  const normalized = new Set(fieldNames.map((name) => normalizeLookup(name)));
  const moneyAliases = [...MONEY_FIELDS, ...UNIT_PRICE_FIELDS].map(
    normalizeLookup,
  );
  if (!moneyAliases.some((alias) => normalized.has(alias))) {
    return `Bảng ${source} thiếu field số tiền hoặc đơn giá. Field hiện có: ${fieldNames.join(', ')}`;
  }
  return null;
}

function fieldMap(fields: Record<string, unknown>) {
  return new Map(Object.keys(fields).map((key) => [normalizeLookup(key), key]));
}

function readAlias(
  fields: Record<string, unknown>,
  aliases: string[],
): unknown {
  const keys = fieldMap(fields);
  for (const alias of aliases) {
    const key = keys.get(normalizeLookup(alias));
    if (!key) continue;
    const value = unwrapLarkValue(fields[key]);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function readLarkAlias(
  fields: Record<string, unknown>,
  aliases: string[],
): unknown {
  return readAlias(fields, aliases);
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

function unwrapLarkValue(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'value' in (value as Record<string, unknown>)
  ) {
    return unwrapLarkValue((value as Record<string, unknown>).value);
  }
  return value;
}

export function readLarkNumber(value: unknown): number | null {
  const raw = unwrapLarkValue(value);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = readLarkNumber(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(trimmed)) {
    return Number(trimmed.replace(/\./g, ''));
  }
  if (/^\d{1,3}(,\d{3})+$/.test(trimmed)) {
    return Number(trimmed.replace(/,/g, ''));
  }
  const parsed = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function readLarkText(value: unknown): string {
  const raw = unwrapLarkValue(value);
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string' || typeof raw === 'number')
    return String(raw).trim();
  if (Array.isArray(raw)) {
    return raw
      .map((item) => readLarkText(item))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    return readLarkText(record.name ?? record.text ?? record.label ?? '');
  }
  return '';
}

function readDate(value: unknown): Date | null {
  const raw = unwrapLarkValue(value);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 20000 && raw <= 100000) {
      const excelEpoch = Date.UTC(1899, 11, 31);
      const date = new Date(
        excelEpoch + raw * 86400000 - 7 * 60 * 60 * 1000,
      );
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const millis = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = readLarkText(raw);
  if (!text) return null;
  const serial = Number(text);
  if (Number.isFinite(serial) && serial >= 20000 && serial <= 100000) {
    const excelEpoch = Date.UTC(1899, 11, 31);
    const date = new Date(
      excelEpoch + serial * 86400000 - 7 * 60 * 60 * 1000,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readLarkDate(value: unknown): Date | null {
  return readDate(value);
}

function isTicked(value: unknown): boolean {
  const raw = unwrapLarkValue(value);
  if (raw === true || raw === 1) return true;
  const text = normalizeLookup(readLarkText(raw));
  return ['co', 'x', 'yes', 'da duyet', 'da kiem tra', 'da tick'].includes(
    text,
  );
}

function collectTicks(fields: Record<string, unknown>) {
  let accountantTicked = false;
  let managerTicked = false;
  let cashIssued = false;
  let rejected = false;
  let approvedText = false;
  for (const [name, value] of Object.entries(fields)) {
    const normalized = normalizeLookup(name);
    if (normalized.includes('trang thai')) {
      const text = normalizeLookup(readLarkText(value));
      if (text.includes('tu choi')) rejected = true;
      if (text.includes('da duyet') || text.includes('da chi'))
        approvedText = true;
    }
    if (normalized.includes('ke toan') && isTicked(value))
      accountantTicked = true;
    if (normalized.includes('quan ly') && isTicked(value)) managerTicked = true;
    if (normalized.includes('da chi') && isTicked(value)) cashIssued = true;
  }
  return { accountantTicked, managerTicked, cashIssued, rejected, approvedText };
}

function readAttachments(fields: Record<string, unknown>): LarkAttachmentRef[] {
  const found: LarkAttachmentRef[] = [];
  const keys = fieldMap(fields);
  const names = new Set<string>();
  for (const alias of FILE_FIELDS) {
    const key = keys.get(normalizeLookup(alias));
    if (key) names.add(key);
  }
  for (const name of Object.keys(fields)) {
    if (
      normalizeLookup(name).includes('chung tu') ||
      normalizeLookup(name).includes('hinh anh')
    ) {
      names.add(name);
    }
  }
  for (const name of names) {
    const value = unwrapLarkValue(fields[name]);
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object' || !('file_token' in item))
        continue;
      const file = item as Record<string, unknown>;
      const fileToken = textValue(file.file_token);
      if (!fileToken) continue;
      found.push({
        fileToken,
        name: textValue(file.name),
        type: textValue(file.type),
        url: textValue(file.url),
        tmpUrl: textValue(file.tmp_url),
      });
    }
  }
  return found;
}

function readPersonRefs(value: unknown): LarkPersonRef[] {
  const raw = unwrapLarkValue(value);
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const record = item as Record<string, unknown>;
      const id =
        textValue(record.id) ||
        textValue(record.open_id) ||
        textValue(record.user_id) ||
        null;
      const name =
        textValue(record.name) ||
        textValue(record.text) ||
        textValue(record.label) ||
        null;
      return { id, name };
    })
    .filter((item) => item.id || item.name);
}

function readPersonAlias(
  fields: Record<string, unknown>,
  aliases: string[],
): LarkPersonRef | null {
  const keys = fieldMap(fields);
  for (const alias of aliases) {
    const key = keys.get(normalizeLookup(alias));
    if (!key) continue;
    const person = readPersonRefs(fields[key])[0];
    if (person) return person;
  }
  return null;
}

export function readLarkPersonAlias(
  fields: Record<string, unknown>,
  aliases: string[],
): LarkPersonRef | null {
  return readPersonAlias(fields, aliases);
}

function invoiceCodesFrom(fields: Record<string, unknown>): string[] {
  const text = Object.values(fields)
    .map((value) => readLarkText(value))
    .join(' ');
  return Array.from(text.match(/HD\d{6}(?:\.\d+)?/g) || []);
}

function amountFrom(fields: Record<string, unknown>): number | null {
  const direct = readLarkNumber(readAlias(fields, MONEY_FIELDS));
  if (direct !== null) return direct;
  const unitPrice = readLarkNumber(readAlias(fields, UNIT_PRICE_FIELDS));
  if (unitPrice === null) return null;
  const quantity = readLarkNumber(readAlias(fields, QUANTITY_FIELDS)) ?? 1;
  return unitPrice * quantity;
}

function isDeliveryExpense(fields: Record<string, unknown>): boolean {
  const blob = normalizeLookup(
    `${readLarkText(readAlias(fields, CATEGORY_FIELDS))} ${readLarkText(
      readAlias(fields, CONTENT_FIELDS),
    )}`,
  );
  return /gui ben|grab|cuoc gui|cuoc nhan|chanh|ship|van chuyen|phi giao/.test(
    blob,
  );
}

function deliverySubCategory(fields: Record<string, unknown>): string {
  const blob = normalizeLookup(
    `${readLarkText(readAlias(fields, CATEGORY_FIELDS))} ${readLarkText(
      readAlias(fields, CONTENT_FIELDS),
    )}`,
  );
  if (blob.includes('gui ben')) return INTERNAL_FINANCE_SUBCATEGORY.FEE_GUI_BEN;
  if (blob.includes('grab')) return INTERNAL_FINANCE_SUBCATEGORY.FEE_GRAB;
  if (blob.includes('cuoc nhan')) return INTERNAL_FINANCE_SUBCATEGORY.SHIPPING_IN;
  if (
    blob.includes('cuoc gui') ||
    blob.includes('chanh') ||
    blob.includes('ship') ||
    blob.includes('phi giao')
  ) {
    return INTERNAL_FINANCE_SUBCATEGORY.SHIPPING_OUT;
  }
  return INTERNAL_FINANCE_SUBCATEGORY.OTHER;
}

export function mapLarkRecord(input: {
  source: LarkImportSource;
  baseToken: string;
  tableId: string;
  tableName: string;
  defaultBranchId: number;
  recordId: string;
  fields: Record<string, unknown>;
}): { entry: MappedLarkEntry | null; skipReason: string | null } {
  const amount = amountFrom(input.fields);
  if (amount === null || amount <= 0) {
    return { entry: null, skipReason: 'Số tiền không hợp lệ' };
  }
  const department = readLarkText(readAlias(input.fields, DEPARTMENT_FIELDS));
  const branchId = branchFromLabel(department) || input.defaultBranchId;
  const ticks = collectTicks(input.fields);
  const attachments = readAttachments(input.fields);
  const content = readLarkText(readAlias(input.fields, CONTENT_FIELDS));
  const direction =
    input.source === 'RECEIPT'
      ? INTERNAL_FINANCE_DIRECTION.RECEIPT
      : INTERNAL_FINANCE_DIRECTION.EXPENSE;
  const status =
    direction === INTERNAL_FINANCE_DIRECTION.RECEIPT
      ? ticks.rejected
        ? INTERNAL_FINANCE_STATUS.REJECTED
        : ticks.approvedText || ticks.accountantTicked
          ? INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED
          : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT
      : ticks.rejected
        ? INTERNAL_FINANCE_STATUS.REJECTED
        : ticks.approvedText || (ticks.accountantTicked && ticks.managerTicked)
          ? INTERNAL_FINANCE_STATUS.APPROVED
          : ticks.accountantTicked
            ? INTERNAL_FINANCE_STATUS.ACCOUNTANT_APPROVED
            : INTERNAL_FINANCE_STATUS.PENDING_ACCOUNTANT;
  const category =
    input.source === 'RECEIPT'
      ? INTERNAL_FINANCE_CATEGORY.MANUAL_RECEIPT
      : input.source === 'SALARY_ADVANCE'
        ? INTERNAL_FINANCE_CATEGORY.SALARY_ADVANCE
        : input.source === 'FUEL'
          ? INTERNAL_FINANCE_CATEGORY.FUEL
          : input.source === 'VEHICLE_CARE'
            ? INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE
            : isDeliveryExpense(input.fields)
              ? INTERNAL_FINANCE_CATEGORY.DELIVERY_FEE
              : INTERNAL_FINANCE_CATEGORY.OTHER_EXPENSE;
  const subCategory =
    input.source === 'FUEL'
      ? INTERNAL_FINANCE_SUBCATEGORY.FUEL
      : input.source === 'VEHICLE_CARE'
        ? INTERNAL_FINANCE_SUBCATEGORY.VEHICLE_CARE
        : input.source === 'SALARY_ADVANCE'
          ? INTERNAL_FINANCE_SUBCATEGORY.SALARY_ADVANCE
          : input.source === 'RECEIPT'
            ? INTERNAL_FINANCE_SUBCATEGORY.OTHER
            : category === INTERNAL_FINANCE_CATEGORY.DELIVERY_FEE
              ? deliverySubCategory(input.fields)
              : INTERNAL_FINANCE_SUBCATEGORY.OTHER;
  const vehicle = readLarkText(readAlias(input.fields, VEHICLE_FIELDS));
  const serviceType = readLarkText(readAlias(input.fields, SERVICE_FIELDS));
  const description =
    content || [vehicle, serviceType].filter(Boolean).join(' - ') || null;
  const larkCreator = readPersonAlias(input.fields, [
    'Người Tạo',
    'Người tạo phiếu',
    'Created By',
    'Created By 2',
    'Created by',
  ]);
  const larkPayer = readPersonAlias(input.fields, PAYER_FIELDS);
  const larkAccountant = readPersonAlias(input.fields, [
    'Kế Toán',
    'Kế Toán Kho',
    'Accountant',
  ]);
  const larkManager = readPersonAlias(input.fields, [
    'Quản Lý',
    'Quản Lý Kho',
    'Manager',
  ]);

  return {
    entry: {
      sourceKey: `LARK:${input.baseToken}:${input.tableId}:${input.recordId}`,
      code: '',
      direction,
      category,
      subCategory,
      branchId,
      amount,
      occurredAt: readDate(readAlias(input.fields, DATE_FIELDS)),
      description,
      status,
      evidenceStatus: attachments.length
        ? INTERNAL_FINANCE_EVIDENCE_STATUS.COMPLETE
        : INTERNAL_FINANCE_EVIDENCE_STATUS.MISSING,
      slipCode: readLarkText(readAlias(input.fields, SLIP_FIELDS)) || null,
      customerName:
        readLarkText(readAlias(input.fields, CUSTOMER_FIELDS)) || null,
      invoiceCodes: invoiceCodesFrom(input.fields),
      accountantTicked: ticks.accountantTicked,
      managerTicked: ticks.managerTicked,
      cashIssued: ticks.cashIssued,
      larkCreator,
      larkPayer,
      larkAccountant,
      larkManager,
      attachments,
      sourceSnapshot: {
        vehicle: vehicle || undefined,
        location:
          readLarkText(readAlias(input.fields, LOCATION_FIELDS)) || undefined,
        odo: readLarkText(readAlias(input.fields, ODO_FIELDS)) || undefined,
        unitPrice:
          readLarkText(readAlias(input.fields, UNIT_PRICE_FIELDS)) || undefined,
        liters:
          readLarkText(readAlias(input.fields, LITER_FIELDS)) || undefined,
        consumptionLimit:
          readLarkText(readAlias(input.fields, LIMIT_FIELDS)) || undefined,
        serviceType: serviceType || undefined,
        anomalyNote:
          readLarkText(readAlias(input.fields, ANOMALY_FIELDS)) || undefined,
        payerName:
          readLarkText(readAlias(input.fields, PAYER_FIELDS)) || undefined,
        larkUsers: {
          creator: larkCreator || undefined,
          payer: larkPayer || undefined,
          accountant: larkAccountant || undefined,
          manager: larkManager || undefined,
        },
        lark: {
          baseToken: input.baseToken,
          tableId: input.tableId,
          tableName: input.tableName,
          recordId: input.recordId,
          source: input.source,
        },
        fields: input.fields,
      },
    },
    skipReason: null,
  };
}
