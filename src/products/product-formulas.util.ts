import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Nhiều công thức thành phần cho hàng sản xuất (type 4).
 * Mỗi công thức = 1 nhóm ProductComponent cùng formulaId. Đúng 1 công thức
 * isDefault — dùng tính giá vốn sản phẩm & là `comboComponents` trả về cho
 * các màn hình cũ. Combo (type 1) không dùng công thức (formulaId = null).
 */

export interface FormulaComponentInput {
  componentProductId: number;
  quantity: number;
  inputMode?: string;
}

export interface FormulaInput {
  id?: number;
  name: string;
  isDefault?: boolean;
  components: FormulaComponentInput[];
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
  },
};

/**
 * Chuẩn hoá + kiểm tra danh sách công thức: tên không trống / không trùng,
 * mỗi công thức có ít nhất 1 thành phần và không trùng thành phần, đúng 1
 * công thức mặc định (không đánh dấu → lấy công thức đầu tiên).
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
    return { ...f, name, isDefault: !!f.isDefault };
  });

  const defaults = result.filter((f) => f.isDefault).length;
  if (defaults > 1) {
    throw new BadRequestException('Chỉ được chọn 1 công thức mặc định');
  }
  if (defaults === 0) result[0].isDefault = true;
  return result;
}

export function defaultFormulaComponents(
  formulas: FormulaInput[],
): FormulaComponentInput[] {
  return (formulas.find((f) => f.isDefault) ?? formulas[0])?.components ?? [];
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
    const data = { name: f.name, isDefault: !!f.isDefault, sortOrder };
    const formula =
      f.id && existingIds.has(f.id)
        ? await tx.productFormula.update({ where: { id: f.id }, data })
        : await tx.productFormula.create({ data: { ...data, productId } });
    await replaceComponents(tx, productId, formula.id, f.components);
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
      where: { productId, isDefault: true },
    })) ??
    (await tx.productFormula.create({
      data: { productId, name: 'Công thức 1', isDefault: true, sortOrder: 0 },
    }));
  await tx.productComponent.deleteMany({
    where: { comboProductId: productId, formulaId: null },
  });
  await replaceComponents(tx, productId, formula.id, components);
}
