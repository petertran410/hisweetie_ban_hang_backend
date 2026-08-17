/**
 * Kiểm tra vi phạm MOQ trên phiếu đặt hàng nhập.
 *
 * Nguyên tắc: MOQ cấp nhà máy (thường `PER_ORDER`) và MOQ cấp mapping
 * sản phẩm × nhà máy (`PER_LINE`) là **hai ràng buộc độc lập, phải thoả
 * mãn đồng thời** — không cái nào override cái nào.
 *
 * Kết quả chỉ dùng để **cảnh báo**, không chặn lưu phiếu.
 */

import {
  MoqMeasureIssue,
  MoqProductInfo,
  MoqSpec,
  MOQ_UNIT_LABEL,
  formatMoqSpec,
  measureLine,
} from './moq.util';

export interface MoqCheckLine {
  productId: number;
  /** Số gói lẻ. */
  quantity: number;
  factoryId?: number | null;
}

export type MoqViolationCode =
  | 'BELOW_MOQ'
  | 'NOT_MULTIPLE_OF_INCREMENT'
  | 'DATA_MISSING';

export interface MoqViolation {
  code: MoqViolationCode;
  level: 'LINE' | 'ORDER';
  factoryId: number;
  factoryName?: string | null;
  productId?: number;
  productName?: string | null;
  /** Ngưỡng yêu cầu, theo đơn vị của MOQ. */
  required: number;
  /** Giá trị hiện tại đã quy đổi. `null` khi thiếu dữ liệu. */
  current: number | null;
  /** Phần còn thiếu để đạt MOQ. `null` khi thiếu dữ liệu. */
  missing: number | null;
  spec: MoqSpec;
  issues: MoqMeasureIssue[];
  message: string;
}

export interface MoqCheckInput {
  lines: MoqCheckLine[];
  /** MOQ mặc định theo nhà máy. */
  factorySpecs: Map<number, { name?: string | null; spec: MoqSpec | null }>;
  /** MOQ riêng theo cặp `${factoryId}:${productId}`. */
  mappingSpecs: Map<string, MoqSpec | null>;
  products: Map<number, MoqProductInfo>;
}

const fmt = (n: number) =>
  n.toLocaleString('vi-VN', { maximumFractionDigits: 3 });

/** Sai số cho phép khi so sánh số thực (tránh 1.9999999 < 2). */
const EPS = 1e-6;

const ISSUE_LABEL: Record<MoqMeasureIssue, string> = {
  MISSING_WEIGHT: 'sản phẩm chưa khai khối lượng tịnh',
  MISSING_CONVERSION: 'sản phẩm chưa khai quy cách đóng gói',
  UNKNOWN_WEIGHT_UNIT: 'đơn vị khối lượng không hợp lệ',
};

export function checkMoq(input: MoqCheckInput): MoqViolation[] {
  const { lines, factorySpecs, mappingSpecs, products } = input;
  const violations: MoqViolation[] = [];

  // ── MOQ cấp dòng (mapping sản phẩm × nhà máy) ───────────────────────────
  for (const line of lines) {
    const factoryId = line.factoryId ?? null;
    if (factoryId == null) continue;

    const spec =
      mappingSpecs.get(`${factoryId}:${line.productId}`) ??
      // Nhà máy khai MOQ ở phạm vi từng sản phẩm thì áp cho mọi dòng.
      (factorySpecs.get(factoryId)?.spec?.scope === 'PER_LINE'
        ? factorySpecs.get(factoryId)!.spec
        : null);
    if (!spec) continue;

    const product = products.get(line.productId);
    if (!product) continue;

    const measured = measureLine(line.quantity, spec.unit, product);
    const factoryName = factorySpecs.get(factoryId)?.name ?? null;

    if (measured.value == null) {
      violations.push({
        code: 'DATA_MISSING',
        level: 'LINE',
        factoryId,
        factoryName,
        productId: line.productId,
        productName: product.productName ?? null,
        required: spec.value,
        current: null,
        missing: null,
        spec,
        issues: measured.issues,
        message: `Không kiểm tra được MOQ ${formatMoqSpec(spec)} cho "${
          product.productName ?? `#${line.productId}`
        }": ${measured.issues.map((i) => ISSUE_LABEL[i]).join(', ')}.`,
      });
      continue;
    }

    pushThresholdViolations({
      violations,
      spec,
      measured: measured.value,
      level: 'LINE',
      factoryId,
      factoryName,
      productId: line.productId,
      productName: product.productName ?? null,
      subject: `Sản phẩm "${product.productName ?? `#${line.productId}`}"`,
    });
  }

  // ── MOQ cấp đơn (gom theo nhà máy) ──────────────────────────────────────
  const totalsByFactory = new Map<
    number,
    { total: number; issues: Set<MoqMeasureIssue>; blocked: boolean }
  >();

  for (const line of lines) {
    const factoryId = line.factoryId ?? null;
    if (factoryId == null) continue;

    const spec = factorySpecs.get(factoryId)?.spec;
    if (!spec || spec.scope !== 'PER_ORDER') continue;

    const product = products.get(line.productId);
    if (!product) continue;

    const acc = totalsByFactory.get(factoryId) ?? {
      total: 0,
      issues: new Set<MoqMeasureIssue>(),
      blocked: false,
    };

    const measured = measureLine(line.quantity, spec.unit, product);
    if (measured.value == null) {
      // Thiếu dữ liệu 1 dòng thì tổng toàn đơn không còn đáng tin.
      acc.blocked = true;
      measured.issues.forEach((i) => acc.issues.add(i));
    } else {
      acc.total += measured.value;
    }

    totalsByFactory.set(factoryId, acc);
  }

  for (const [factoryId, acc] of totalsByFactory) {
    const entry = factorySpecs.get(factoryId);
    const spec = entry?.spec;
    if (!spec) continue;

    const factoryName = entry?.name ?? null;
    const subject = `Nhà máy "${factoryName ?? `#${factoryId}`}"`;

    if (acc.blocked) {
      violations.push({
        code: 'DATA_MISSING',
        level: 'ORDER',
        factoryId,
        factoryName,
        required: spec.value,
        current: null,
        missing: null,
        spec,
        issues: [...acc.issues],
        message: `${subject}: không kiểm tra được MOQ ${formatMoqSpec(
          spec,
        )}/lần đặt vì ${[...acc.issues]
          .map((i) => ISSUE_LABEL[i])
          .join(', ')}.`,
      });
      continue;
    }

    pushThresholdViolations({
      violations,
      spec,
      measured: acc.total,
      level: 'ORDER',
      factoryId,
      factoryName,
      subject: `${subject} (toàn đơn)`,
    });
  }

  return violations;
}

/** So ngưỡng MOQ + bội số cho một giá trị đã quy đổi. */
function pushThresholdViolations(args: {
  violations: MoqViolation[];
  spec: MoqSpec;
  measured: number;
  level: 'LINE' | 'ORDER';
  factoryId: number;
  factoryName?: string | null;
  productId?: number;
  productName?: string | null;
  subject: string;
}) {
  const {
    violations,
    spec,
    measured,
    level,
    factoryId,
    factoryName,
    productId,
    productName,
    subject,
  } = args;

  const unitLabel = MOQ_UNIT_LABEL[spec.unit];

  if (measured + EPS < spec.value) {
    const missing = spec.value - measured;
    violations.push({
      code: 'BELOW_MOQ',
      level,
      factoryId,
      factoryName,
      productId,
      productName,
      required: spec.value,
      current: measured,
      missing,
      spec,
      issues: [],
      message: `${subject}: còn thiếu ${fmt(
        missing,
      )} ${unitLabel} để đạt MOQ ${fmt(spec.value)} ${unitLabel} (hiện ${fmt(
        measured,
      )} ${unitLabel}).`,
    });
    return;
  }

  // Đã đạt MOQ — phần vượt phải là bội số của `increment` (nếu có khai).
  if (spec.increment && spec.increment > 0) {
    const excess = measured - spec.value;
    const remainder = excess % spec.increment;
    if (remainder > EPS && spec.increment - remainder > EPS) {
      const missing = spec.increment - remainder;
      violations.push({
        code: 'NOT_MULTIPLE_OF_INCREMENT',
        level,
        factoryId,
        factoryName,
        productId,
        productName,
        required: spec.value,
        current: measured,
        missing,
        spec,
        issues: [],
        message: `${subject}: phần vượt MOQ phải là bội số của ${fmt(
          spec.increment,
        )} ${unitLabel} — cần thêm ${fmt(missing)} ${unitLabel}.`,
      });
    }
  }
}
