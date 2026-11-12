import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isNsxUnit,
  normalizeNsxUnit,
  nsxPriceFactor,
} from '../common/nsx-pricing.util';

/**
 * Nhiều công thức thành phần cho hàng sản xuất (type 4).
 * Mỗi công thức = 1 nhóm ProductComponent cùng formulaId. Đúng 1 công thức
 * isDefault — dùng tính giá vốn sản phẩm & là `comboComponents` trả về cho
 * các màn hình cũ. Combo (type 1) không dùng công thức (formulaId = null).
 *
 * Công thức gửi đi sản xuất (isExternal): thêm nguyên liệu NSX bổ sung, phí gia
 * công / 1 sp và tiền tệ. Không bao giờ là mặc định (mặc định quyết định giá vốn
 * kho từ hàng mình) và không dùng cho sản xuất nội bộ.
 */

export interface FormulaComponentInput {
  componentProductId: number;
  quantity: number;
  inputMode?: string;
}

/** Nguyên liệu NSX bổ sung — định lượng cho 1 thành phẩm. */
export interface FormulaNsxLineInput {
  productId: number;
  quantity: number;
  unit: string;
  unitPrice: number;
  priceUnit: string;
}

/** Các trường gửi đi: `undefined` = client không gửi (vd app mobile) → giữ giá trị đã lưu. */
export interface FormulaInput {
  id?: number;
  name: string;
  isDefault?: boolean;
  components: FormulaComponentInput[];
  isExternal?: boolean;
  processingFeePerUnit?: number;
  currency?: string;
  nsxLines?: FormulaNsxLineInput[];
}

/** Công thức đã lưu (kèm nsxLines) — dùng để bù các trường client không gửi. */
interface StoredFormula {
  id: number;
  isExternal: boolean;
  processingFeePerUnit: Prisma.Decimal.Value;
  currency: string;
  nsxLines: {
    productId: number;
    quantity: Prisma.Decimal.Value;
    unit: string;
    unitPrice: Prisma.Decimal.Value;
    priceUnit: string;
  }[];
}

type Tx = Prisma.TransactionClient;

/** Lọc `comboComponents` chỉ lấy thành phần của công thức mặc định (hoặc combo). */
export const DEFAULT_COMPONENTS_WHERE: Prisma.ProductComponentWhereInput = {
  OR: [{ formulaId: null }, { formula: { isDefault: true } }],
};

/** Include danh sách công thức kèm thành phần (đọc chi tiết sản phẩm). */
export const FORMULAS_INCLUDE = {
  orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  include: {
    components: {
      orderBy: { id: 'asc' as const },
      include: {
        componentProduct: {
          include: { images: true, inventories: true },
        },
      },
    },
    nsxLines: {
      orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            unit: true,
            weight: true,
            weightUnit: true,
          },
        },
      },
    },
  },
};

const round6 = (value: Prisma.Decimal.Value) =>
  new Prisma.Decimal(value).toDecimalPlaces(6).toNumber();

/**
 * Bù các trường gửi đi cho công thức đã có (theo id) khi client không gửi —
 * app mobile chỉ gửi {id, name, isDefault, components}. Gửi `nsxLines: []`
 * mới là xoá; công thức không có id là công thức mới (nội bộ nếu không gửi).
 */
export function mergeStoredFormulaFields(
  inputs: FormulaInput[],
  existing: StoredFormula[],
): FormulaInput[] {
  const byId = new Map(existing.map((f) => [f.id, f]));
  return inputs.map((f) => {
    const stored = f.id ? byId.get(f.id) : undefined;
    if (!stored) return f;
    return {
      ...f,
      isExternal: f.isExternal ?? stored.isExternal,
      processingFeePerUnit:
        f.processingFeePerUnit ?? Number(stored.processingFeePerUnit),
      currency: f.currency ?? stored.currency,
      nsxLines:
        f.nsxLines ??
        stored.nsxLines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unit: l.unit,
          unitPrice: Number(l.unitPrice),
          priceUnit: l.priceUnit,
        })),
    };
  });
}

function normalizeNsxLines(
  name: string,
  lines: FormulaNsxLineInput[],
): FormulaNsxLineInput[] {
  const ids = new Set<number>();
  return lines.map((l) => {
    if (!(Number(l.productId) >= 1)) {
      throw new BadRequestException(
        `Công thức "${name}": nguyên liệu NSX cần chọn sản phẩm`,
      );
    }
    if (ids.has(l.productId)) {
      throw new BadRequestException(
        `Công thức "${name}": nguyên liệu NSX bị trùng mã`,
      );
    }
    ids.add(l.productId);
    const quantity = round6(Number(l.quantity) || 0);
    if (!(quantity > 0)) {
      throw new BadRequestException(
        `Công thức "${name}": nguyên liệu NSX cần định lượng lớn hơn 0`,
      );
    }
    const unit = normalizeNsxUnit(l.unit);
    const priceUnit = normalizeNsxUnit(l.priceUnit);
    if (!isNsxUnit(unit) || !isNsxUnit(priceUnit)) {
      throw new BadRequestException(
        `Công thức "${name}": đơn vị nguyên liệu NSX phải là g, kg hoặc gói`,
      );
    }
    nsxPriceFactor(unit, priceUnit);
    const unitPrice = Number(l.unitPrice) || 0;
    if (unitPrice < 0) {
      throw new BadRequestException(
        `Công thức "${name}": đơn giá nguyên liệu NSX không được âm`,
      );
    }
    return {
      productId: l.productId,
      quantity,
      unit,
      unitPrice: round6(unitPrice),
      priceUnit,
    };
  });
}

/**
 * Chuẩn hoá + kiểm tra danh sách công thức: tên không trống / không trùng,
 * mỗi công thức có ít nhất 1 thành phần hàng mình và không trùng thành phần.
 * Công thức gửi đi: kiểm tra dòng NSX (có thể không có dòng nào), không được
 * làm mặc định. Đúng 1 mặc định trong số công thức nội bộ (không đánh dấu →
 * công thức nội bộ đầu tiên); toàn công thức gửi đi → không có mặc định.
 */
export function normalizeFormulas(formulas: FormulaInput[]): FormulaInput[] {
  if (!formulas.length) {
    throw new BadRequestException('Hàng sản xuất cần ít nhất 1 công thức');
  }
  const names = new Set<string>();
  const result = formulas.map((f, idx) => {
    const name = (f.name || '').trim() || `Công thức ${idx + 1}`;
    const key = name.toLowerCase();
    if (names.has(key)) {
      throw new BadRequestException(`Trùng tên công thức "${name}"`);
    }
    names.add(key);
    if (!f.components?.length) {
      throw new BadRequestException(`Công thức "${name}" chưa có thành phần`);
    }
    const ids = new Set<number>();
    for (const c of f.components) {
      if (ids.has(c.componentProductId)) {
        throw new BadRequestException(
          `Công thức "${name}" có thành phần bị trùng`,
        );
      }
      ids.add(c.componentProductId);
    }
    const isExternal = !!f.isExternal;
    if (!isExternal) {
      return {
        ...f,
        name,
        isDefault: !!f.isDefault,
        isExternal: false,
        processingFeePerUnit: 0,
        currency: 'VND',
        nsxLines: [],
      };
    }
    const fee = Number(f.processingFeePerUnit) || 0;
    if (fee < 0) {
      throw new BadRequestException(
        `Công thức "${name}": phí gia công không được âm`,
      );
    }
    return {
      ...f,
      name,
      // Công thức gửi đi không bao giờ là mặc định — bỏ qua cờ (vd từ mobile).
      isDefault: false,
      isExternal: true,
      processingFeePerUnit: round6(fee),
      currency: f.currency === 'CNY' ? 'CNY' : 'VND',
      nsxLines: normalizeNsxLines(name, f.nsxLines ?? []),
    };
  });

  const defaults = result.filter((f) => f.isDefault).length;
  if (defaults > 1) {
    throw new BadRequestException('Chỉ được chọn 1 công thức mặc định');
  }
  const firstInternal = result.find((f) => !f.isExternal);
  if (defaults === 0 && firstInternal) firstInternal.isDefault = true;
  return result;
}

export function defaultFormulaComponents(
  formulas: FormulaInput[],
): FormulaComponentInput[] {
  return formulas.find((f) => f.isDefault && !f.isExternal)?.components ?? [];
}

async function replaceNsxLines(
  tx: Tx,
  formulaId: number,
  lines: FormulaNsxLineInput[],
) {
  await tx.productFormulaNsxLine.deleteMany({ where: { formulaId } });
  if (!lines.length) return;
  const ids = [...new Set(lines.map((l) => l.productId))];
  const found = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new BadRequestException('Không tìm thấy nguyên liệu NSX');
  }
  await tx.productFormulaNsxLine.createMany({
    data: lines.map((l, sortOrder) => ({
      formulaId,
      productId: l.productId,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      priceUnit: l.priceUnit,
      sortOrder,
    })),
  });
}

async function replaceComponents(
  tx: Tx,
  productId: number,
  formulaId: number,
  components: FormulaComponentInput[],
) {
  await tx.productComponent.deleteMany({ where: { formulaId } });
  if (components.length > 0) {
    await tx.productComponent.createMany({
      data: components.map((c) => ({
        comboProductId: productId,
        formulaId,
        componentProductId: c.componentProductId,
        quantity: c.quantity,
        inputMode: c.inputMode ?? 'gram',
      })),
    });
  }
}

/**
 * Ghi đè toàn bộ công thức của sản phẩm theo payload (đã normalize):
 * công thức có id → cập nhật, không id → tạo mới, không còn trong payload →
 * xoá. Thành phần cũ chưa gắn công thức (dữ liệu trước khi backfill) cũng
 * được dọn vì form đã nạp chúng thành công thức mặc định.
 */
export async function saveProductFormulas(
  tx: Tx,
  productId: number,
  formulas: FormulaInput[],
) {
  const existing = await tx.productFormula.findMany({
    where: { productId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((f) => f.id));
  const keepIds = formulas
    .map((f) => f.id)
    .filter((id): id is number => !!id && existingIds.has(id));

  await tx.productFormula.deleteMany({
    where: { productId, id: { notIn: keepIds } },
  });
  await tx.productComponent.deleteMany({
    where: { comboProductId: productId, formulaId: null },
  });

  for (const [sortOrder, f] of formulas.entries()) {
    const data = {
      name: f.name,
      isDefault: !!f.isDefault,
      sortOrder,
      isExternal: !!f.isExternal,
      processingFeePerUnit: f.processingFeePerUnit ?? 0,
      currency: f.currency ?? 'VND',
    };
    const formula =
      f.id && existingIds.has(f.id)
        ? await tx.productFormula.update({ where: { id: f.id }, data })
        : await tx.productFormula.create({ data: { ...data, productId } });
    await replaceComponents(tx, productId, formula.id, f.components);
    await replaceNsxLines(tx, formula.id, f.nsxLines ?? []);
  }
}

/**
 * Chỉ thay thành phần của công thức mặc định (tạo nếu chưa có) — dùng cho
 * luồng chỉ biết 1 danh sách thành phần (import Excel, đồng bộ KiotViet,
 * client cũ gửi `components`). Các công thức khác giữ nguyên.
 */
export async function replaceDefaultFormulaComponents(
  tx: Tx,
  productId: number,
  components: FormulaComponentInput[],
) {
  const formula =
    (await tx.productFormula.findFirst({
      where: { productId, isDefault: true, isExternal: false },
    })) ?? (await createDefaultFormula(tx, productId));
  await tx.productComponent.deleteMany({
    where: { comboProductId: productId, formulaId: null },
  });
  await replaceComponents(tx, productId, formula.id, components);
}

/** Tạo công thức mặc định nội bộ với tên "Công thức N" chưa bị trùng. */
async function createDefaultFormula(tx: Tx, productId: number) {
  const existing = await tx.productFormula.findMany({
    where: { productId },
    select: { name: true },
  });
  const used = new Set(existing.map((f) => f.name.trim().toLowerCase()));
  let n = 1;
  while (used.has(`công thức ${n}`)) n++;
  return tx.productFormula.create({
    data: { productId, name: `Công thức ${n}`, isDefault: true, sortOrder: 0 },
  });
}
