/**
 * MOQ (Minimum Order Quantity) — quy đổi & kiểm tra.
 *
 * MOQ được mô tả bằng 3 chiều thay vì 1 con số trần:
 *  - `basis`: đo bằng gì (số lượng hay khối lượng)
 *  - `unit` : đơn vị cụ thể của basis
 *  - `scope`: áp cho từng dòng hay toàn đơn (chỉ có ở cấp nhà máy)
 *
 * Số lượng người dùng nhập trên phiếu đặt hàng nhập luôn là **gói lẻ**
 * (xem `OrderSupplierForm`), nên mọi quy đổi đều lấy gói lẻ làm gốc.
 *
 * Khối lượng dùng **khối lượng tịnh** (`Product.weight`), KHÔNG dùng
 * `shippingWeight` (đã gồm bao bì) — theo thống nhất nghiệp vụ.
 */

export type MoqBasis = 'QUANTITY' | 'WEIGHT';
export type MoqUnit = 'PACK' | 'CARTON' | 'KG' | 'TON';
export type MoqScope = 'PER_ORDER' | 'PER_LINE';

export const MOQ_BASES: MoqBasis[] = ['QUANTITY', 'WEIGHT'];
export const MOQ_SCOPES: MoqScope[] = ['PER_ORDER', 'PER_LINE'];
export const MOQ_UNITS: MoqUnit[] = ['PACK', 'CARTON', 'KG', 'TON'];

/** Đơn vị hợp lệ tương ứng từng basis. */
export const MOQ_UNITS_BY_BASIS: Record<MoqBasis, MoqUnit[]> = {
  QUANTITY: ['PACK', 'CARTON'],
  WEIGHT: ['KG', 'TON'],
};

export const MOQ_UNIT_LABEL: Record<MoqUnit, string> = {
  PACK: 'gói',
  CARTON: 'thùng',
  KG: 'kg',
  TON: 'tấn',
};

export const MOQ_BASIS_LABEL: Record<MoqBasis, string> = {
  QUANTITY: 'Số lượng',
  WEIGHT: 'Khối lượng',
};

export const MOQ_SCOPE_LABEL: Record<MoqScope, string> = {
  PER_ORDER: 'Toàn đơn',
  PER_LINE: 'Từng sản phẩm',
};

/** Cấu hình MOQ đã chuẩn hoá. */
export interface MoqSpec {
  value: number;
  basis: MoqBasis;
  unit: MoqUnit;
  scope: MoqScope;
  /** Bội số bắt buộc cho phần vượt MOQ. `null` = không ràng buộc. */
  increment: number | null;
}

/** Thông tin sản phẩm tối thiểu để quy đổi. */
export interface MoqProductInfo {
  productId: number;
  productName?: string | null;
  /** Số gói lẻ trong 1 thùng. */
  conversionValue: number | null | undefined;
  /** Khối lượng tịnh 1 gói lẻ. */
  weight: number | null | undefined;
  weightUnit: string | null | undefined;
}

/** Lý do không quy đổi được — để cảnh báo thay vì tính sai âm thầm. */
export type MoqMeasureIssue =
  | 'MISSING_WEIGHT'
  | 'MISSING_CONVERSION'
  | 'UNKNOWN_WEIGHT_UNIT';

export interface MoqMeasureResult {
  /** Giá trị đã quy đổi về đơn vị của MOQ. `null` khi thiếu dữ liệu. */
  value: number | null;
  issues: MoqMeasureIssue[];
}

const isPositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Khối lượng tịnh của 1 gói lẻ, quy về kg.
 *
 * `Product.weightUnit` mặc định 'kg' nhưng dữ liệu thực tế có cả 'g'.
 * Giá trị ngoài whitelist trả `null` kèm issue thay vì đoán bừa.
 */
export function netWeightKgPerPack(product: MoqProductInfo): MoqMeasureResult {
  const weight = toNum(product.weight);
  if (!isPositive(weight)) {
    return { value: null, issues: ['MISSING_WEIGHT'] };
  }

  const unit = (product.weightUnit || 'kg').trim().toLowerCase();
  switch (unit) {
    case 'g':
    case 'gram':
    case 'gam':
      return { value: weight / 1000, issues: [] };
    case 'kg':
    case 'kilogram':
      return { value: weight, issues: [] };
    case 'ton':
    case 'tan':
    case 'tấn':
      return { value: weight * 1000, issues: [] };
    default:
      return { value: null, issues: ['UNKNOWN_WEIGHT_UNIT'] };
  }
}

/**
 * Quy đổi số lượng đặt (gói lẻ) của 1 dòng sang đơn vị của MOQ.
 *
 * @param qtyPacks số gói lẻ người dùng nhập trên phiếu
 */
export function measureLine(
  qtyPacks: number,
  unit: MoqUnit,
  product: MoqProductInfo,
): MoqMeasureResult {
  const qty = toNum(qtyPacks) ?? 0;

  switch (unit) {
    case 'PACK':
      return { value: qty, issues: [] };

    case 'CARTON': {
      const conv = toNum(product.conversionValue);
      if (!isPositive(conv)) {
        return { value: null, issues: ['MISSING_CONVERSION'] };
      }
      return { value: qty / conv, issues: [] };
    }

    case 'KG': {
      const w = netWeightKgPerPack(product);
      if (w.value == null) return { value: null, issues: w.issues };
      return { value: qty * w.value, issues: [] };
    }

    case 'TON': {
      const w = netWeightKgPerPack(product);
      if (w.value == null) return { value: null, issues: w.issues };
      return { value: (qty * w.value) / 1000, issues: [] };
    }

    default:
      return { value: null, issues: [] };
  }
}

/**
 * Đọc cụm MOQ từ bản ghi Factory / factory_products.
 *
 * Tương thích ngược: bản ghi cũ chỉ có cột `moq` được hiểu là
 * số lượng theo **thùng** — đúng với cách người dùng đang nhập trước đây.
 */
export function normalizeMoqSpec(
  row:
    | {
        moq?: unknown;
        moqValue?: unknown;
        moqBasis?: unknown;
        moqUnit?: unknown;
        moqScope?: unknown;
        moqIncrement?: unknown;
      }
    | null
    | undefined,
  defaultScope: MoqScope,
): MoqSpec | null {
  if (!row) return null;

  const value = toNum(row.moqValue) ?? toNum(row.moq);
  if (!isPositive(value)) return null;

  const basis = MOQ_BASES.includes(row.moqBasis as MoqBasis)
    ? (row.moqBasis as MoqBasis)
    : 'QUANTITY';

  const allowedUnits = MOQ_UNITS_BY_BASIS[basis];
  const unit = allowedUnits.includes(row.moqUnit as MoqUnit)
    ? (row.moqUnit as MoqUnit)
    : allowedUnits[allowedUnits.length - 1]; // QUANTITY→CARTON, WEIGHT→TON

  const scope = MOQ_SCOPES.includes(row.moqScope as MoqScope)
    ? (row.moqScope as MoqScope)
    : defaultScope;

  const increment = toNum(row.moqIncrement);

  return {
    value,
    basis,
    unit,
    scope,
    increment: isPositive(increment) ? increment : null,
  };
}

/** Hiển thị gọn: `100 thùng`, `2 tấn`, `5 tấn (toàn đơn)`. */
export function formatMoqSpec(spec: MoqSpec | null, withScope = false): string {
  if (!spec) return '—';
  const num = spec.value.toLocaleString('vi-VN', { maximumFractionDigits: 3 });
  let text = `${num} ${MOQ_UNIT_LABEL[spec.unit]}`;
  if (spec.increment) {
    const inc = spec.increment.toLocaleString('vi-VN', {
      maximumFractionDigits: 3,
    });
    text += ` (bội số ${inc})`;
  }
  if (withScope) text += ` · ${MOQ_SCOPE_LABEL[spec.scope]}`;
  return text;
}

/**
 * Đọc đơn vị MOQ từ ô Excel — chấp nhận cả nhãn tiếng Việt lẫn mã enum.
 * Trả `undefined` khi ô trống, `null` khi giá trị không hợp lệ.
 */
export function parseMoqUnit(raw: unknown): MoqUnit | null | undefined {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  switch (text) {
    case 'gói':
    case 'goi':
    case 'pack':
      return 'PACK';
    case 'thùng':
    case 'thung':
    case 'carton':
      return 'CARTON';
    case 'kg':
      return 'KG';
    case 'tấn':
    case 'tan':
    case 'ton':
      return 'TON';
    default:
      return null;
  }
}

/** Đọc phạm vi MOQ từ ô Excel. */
export function parseMoqScope(raw: unknown): MoqScope | null | undefined {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  switch (text) {
    case 'toàn đơn':
    case 'toan don':
    case 'per_order':
      return 'PER_ORDER';
    case 'từng sản phẩm':
    case 'tung san pham':
    case 'per_line':
      return 'PER_LINE';
    default:
      return null;
  }
}

/** Suy ra basis từ đơn vị — basis không cần nhập tay trên Excel. */
export function basisOfUnit(unit: MoqUnit): MoqBasis {
  return unit === 'KG' || unit === 'TON' ? 'WEIGHT' : 'QUANTITY';
}
