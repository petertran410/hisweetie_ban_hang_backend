import { BadRequestException } from '@nestjs/common';
import {
  defaultFormulaComponents,
  normalizeFormulas,
  replaceDefaultFormulaComponents,
  saveProductFormulas,
} from './product-formulas.util';

const comp = (componentProductId: number, quantity = 100) => ({
  componentProductId,
  quantity,
  inputMode: 'gram',
});

describe('normalizeFormulas', () => {
  it('không đánh dấu mặc định → công thức đầu tiên là mặc định', () => {
    const result = normalizeFormulas([
      { name: 'A', components: [comp(1)] },
      { name: 'B', components: [comp(2)] },
    ]);
    expect(result.map((f) => f.isDefault)).toEqual([true, false]);
    expect(defaultFormulaComponents(result)).toEqual([comp(1)]);
  });

  it('chặn trùng tên, công thức rỗng, trùng thành phần, 2 mặc định', () => {
    expect(() =>
      normalizeFormulas([
        { name: 'A', components: [comp(1)] },
        { name: ' a ', components: [comp(2)] },
      ]),
    ).toThrow(BadRequestException);
    expect(() => normalizeFormulas([{ name: 'A', components: [] }])).toThrow(
      BadRequestException,
    );
    expect(() =>
      normalizeFormulas([{ name: 'A', components: [comp(1), comp(1, 5)] }]),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeFormulas([
        { name: 'A', isDefault: true, components: [comp(1)] },
        { name: 'B', isDefault: true, components: [comp(2)] },
      ]),
    ).toThrow(BadRequestException);
  });
});

describe('saveProductFormulas', () => {
  const makeTx = (existingIds: number[]) => {
    let nextId = 100;
    return {
      productFormula: {
        findMany: jest
          .fn()
          .mockResolvedValue(existingIds.map((id) => ({ id }))),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(({ where }) => Promise.resolve({ id: where.id })),
        create: jest.fn(() => Promise.resolve({ id: nextId++ })),
      },
      productComponent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  };

  it('cập nhật công thức có id, tạo mới công thức không id, xoá công thức bị bỏ', async () => {
    const tx = makeTx([1, 2]);
    await saveProductFormulas(tx as any, 9, [
      { id: 1, name: 'Gốc', isDefault: true, components: [comp(11)] },
      { name: 'Mới', isDefault: false, components: [comp(12, 50)] },
    ]);

    expect(tx.productFormula.deleteMany).toHaveBeenCalledWith({
      where: { productId: 9, id: { notIn: [1] } },
    });
    expect(tx.productFormula.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Gốc', isDefault: true, sortOrder: 0 },
    });
    expect(tx.productFormula.create).toHaveBeenCalledWith({
      data: { name: 'Mới', isDefault: false, sortOrder: 1, productId: 9 },
    });
    expect(tx.productComponent.createMany).toHaveBeenCalledWith({
      data: [
        {
          comboProductId: 9,
          formulaId: 100,
          componentProductId: 12,
          quantity: 50,
          inputMode: 'gram',
        },
      ],
    });
  });

  it('replaceDefaultFormulaComponents tạo công thức mặc định nếu chưa có', async () => {
    const tx = makeTx([]);
    await replaceDefaultFormulaComponents(tx as any, 9, [comp(11)]);
    expect(tx.productFormula.create).toHaveBeenCalledWith({
      data: {
        productId: 9,
        name: 'Công thức 1',
        isDefault: true,
        sortOrder: 0,
      },
    });
    expect(tx.productComponent.deleteMany).toHaveBeenCalledWith({
      where: { formulaId: 100 },
    });
  });
});
