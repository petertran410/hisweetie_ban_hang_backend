// Quy đổi định mức công thức (ProductComponent) → số lượng theo ĐƠN VỊ TỒN KHO
// của nguyên liệu. Cùng quy tắc với phiếu Sản xuất nội bộ
// (productions.service.ts → processInventoryChanges) để hai nơi không lệch:
//   - piece / carton / nguyên liệu không có weight: quantity × SL thành phẩm
//   - gram: quantity (gram) × SL thành phẩm / trọng lượng 1 đơn vị (gram)

export interface FormulaComponentLike {
  quantity: any;
  inputMode?: string | null;
  componentProduct: { weight?: any; weightUnit?: string | null };
}

export function componentWeightInGrams(product: {
  weight?: any;
  weightUnit?: string | null;
}): number {
  const weight = product.weight ? Number(product.weight) : 0;
  return (product.weightUnit || 'g') === 'kg' ? weight * 1000 : weight;
}

export function formulaComponentToStockUnits(
  comp: FormulaComponentLike,
  finishedQuantity: number,
): number {
  const weightInGrams = componentWeightInGrams(comp.componentProduct);
  const isPieceLike =
    comp.inputMode === 'piece' ||
    comp.inputMode === 'carton' ||
    weightInGrams === 0;

  const raw = Number(comp.quantity) * Number(finishedQuantity);
  const units = isPieceLike ? raw : raw / weightInGrams;
  return Math.round(units * 1e4) / 1e4;
}
