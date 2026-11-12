import { BadRequestException } from '@nestjs/common';
import {
  defaultFormulaComponents,
  mergeStoredFormulaFields,
  normalizeFormulas,
  replaceDefaultFormulaComponents,
  saveProductFormulas,
} from './product-formulas.util';

const comp = (componentProductId: number, quantity = 100) => ({
  componentProductId,
  quantity,
  inputMode: 'gram',
});

const nsx = (productId: number, over: Record<string, unknown> = {}) => ({
  productId,
  quantity: 0.3,
  unit: 'g',
  unitPrice: 250000,
  priceUnit: 'kg',
  ...over,
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

describe('normalizeFormulas — công thức gửi đi sản xuất', () => {
  it('cờ mặc định của công thức gửi đi bị bỏ qua, công thức nội bộ đầu tiên làm mặc định', () => {
    const result = normalizeFormulas([
      { name: 'Gửi', isDefault: true, isExternal: true, components: [comp(1)] },
      { name: 'Nội bộ', components: [comp(2)] },
    ]);
    expect(result.map((f) => [f.isExternal, f.isDefault])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(defaultFormulaComponents(result)).toEqual([comp(2)]);
  });

  it('toàn công thức gửi đi → không có mặc định, không tính giá vốn từ công thức', () => {
    const result = normalizeFormulas([
      { name: 'Gửi', isExternal: true, components: [comp(1)] },
    ]);
    expect(result[0].isDefault).toBe(false);
    expect(defaultFormulaComponents(result)).toEqual([]);
  });

  it('công thức gửi đi không có dòng NSX vẫn hợp lệ (chỉ gửi gia công)', () => {
    const [f] = normalizeFormulas([
      {
        name: 'Chỉ gia công',
        isExternal: true,
        processingFeePerUnit: 0,
        components: [comp(1)],
      },
    ]);
    expect(f.nsxLines).toEqual([]);
    expect(f.currency).toBe('VND');
  });

  it('chuẩn hoá dòng NSX: đơn vị NFD/viết hoa, làm tròn 6 số lẻ', () => {
    const [f] = normalizeFormulas([
      {
        name: 'Gửi',
        isExternal: true,
        currency: 'CNY',
        processingFeePerUnit: 1.23456789,
        components: [comp(1)],
        nsxLines: [
          nsx(5, {
            unit: 'Go\u0301i'.normalize('NFD'),
            priceUnit: ' GÓI ',
            quantity: 0.12345678,
          }),
        ],
      },
    ]);
    expect(f.currency).toBe('CNY');
    expect(f.processingFeePerUnit).toBe(1.234568);
    expect(f.nsxLines).toEqual([
      {
        productId: 5,
        quantity: 0.123457,
        unit: 'gói',
        unitPrice: 250000,
        priceUnit: 'gói',
      },
    ]);
  });

  it('chặn dòng NSX thiếu mã, trùng mã, lượng 0, gói với giá theo kg', () => {
    const external = (lines: any[]) => () =>
      normalizeFormulas([
        { name: 'Gửi', isExternal: true, components: [comp(1)], nsxLines: lines },
      ]);
    expect(external([nsx(0)])).toThrow(BadRequestException);
    expect(external([nsx(5), nsx(5)])).toThrow(BadRequestException);
    expect(external([nsx(5, { quantity: 0 })])).toThrow(BadRequestException);
    expect(external([nsx(5, { unit: 'gói', priceUnit: 'kg' })])).toThrow(
      BadRequestException,
    );
    expect(external([nsx(5, { unit: 'lb' })])).toThrow(BadRequestException);
  });

  it('công thức gửi đi vẫn cần ít nhất 1 thành phần hàng mình', () => {
    expect(() =>
      normalizeFormulas([
        { name: 'Gửi', isExternal: true, components: [], nsxLines: [nsx(5)] },
      ]),
    ).toThrow(BadRequestException);
  });

  it('công thức nội bộ bỏ dòng NSX, phí và tiền tệ', () => {
    const [f] = normalizeFormulas([
      {
        name: 'Nội bộ',
        components: [comp(1)],
        processingFeePerUnit: 500,
        currency: 'CNY',
        nsxLines: [nsx(5)],
      },
    ]);
    expect(f).toMatchObject({
      isExternal: false,
      processingFeePerUnit: 0,
      currency: 'VND',
      nsxLines: [],
    });
  });
});

describe('mergeStoredFormulaFields', () => {
  const stored = [
    {
      id: 7,
      isExternal: true,
      processingFeePerUnit: '500',
      currency: 'CNY',
      nsxLines: [
        { productId: 5, quantity: '0.3', unit: 'g', unitPrice: '250000', priceUnit: 'kg' },
      ],
    },
  ];

  it('payload mobile (thiếu trường gửi đi) giữ nguyên dữ liệu đã lưu', () => {
    const [f] = mergeStoredFormulaFields(
      [{ id: 7, name: 'Gửi', isDefault: true, components: [comp(1)] }],
      stored,
    );
    expect(f).toMatchObject({
      isExternal: true,
      processingFeePerUnit: 500,
      currency: 'CNY',
      nsxLines: [nsx(5)],
    });
    const [normalized] = normalizeFormulas([f]);
    expect(normalized.isDefault).toBe(false);
  });

  it('gửi nsxLines rỗng là xoá; công thức không id là công thức mới', () => {
    const [kept, created] = mergeStoredFormulaFields(
      [
        { id: 7, name: 'Gửi', components: [comp(1)], nsxLines: [] },
        { name: 'Mới', components: [comp(2)] },
      ],
      stored,
    );
    expect(kept.nsxLines).toEqual([]);
    expect(created.isExternal).toBeUndefined();
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
      productFormulaNsxLine: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      product: {
        findMany: jest.fn(({ where }) =>
          Promise.resolve(where.id.in.map((id: number) => ({ id }))),
        ),
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
    const internal = { isExternal: false, processingFeePerUnit: 0, currency: 'VND' };
    expect(tx.productFormula.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Gốc', isDefault: true, sortOrder: 0, ...internal },
    });
    expect(tx.productFormula.create).toHaveBeenCalledWith({
      data: { name: 'Mới', isDefault: false, sortOrder: 1, ...internal, productId: 9 },
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

  it('ghi trường gửi đi và thay toàn bộ dòng NSX', async () => {
    const tx = makeTx([3]);
    await saveProductFormulas(tx as any, 9, [
      {
        id: 3,
        name: 'Gửi',
        isDefault: false,
        isExternal: true,
        processingFeePerUnit: 500,
        currency: 'VND',
        components: [comp(11)],
        nsxLines: [nsx(5)],
      },
    ]);
    expect(tx.productFormula.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        name: 'Gửi',
        isDefault: false,
        sortOrder: 0,
        isExternal: true,
        processingFeePerUnit: 500,
        currency: 'VND',
      },
    });
    expect(tx.productFormulaNsxLine.deleteMany).toHaveBeenCalledWith({
      where: { formulaId: 3 },
    });
    expect(tx.productFormulaNsxLine.createMany).toHaveBeenCalledWith({
      data: [{ formulaId: 3, sortOrder: 0, ...nsx(5) }],
    });
  });

  it('dòng NSX trỏ tới sản phẩm không tồn tại → BadRequest', async () => {
    const tx = makeTx([3]);
    tx.product.findMany.mockResolvedValueOnce([]);
    await expect(
      saveProductFormulas(tx as any, 9, [
        { id: 3, name: 'Gửi', isExternal: true, components: [comp(11)], nsxLines: [nsx(5)] },
      ]),
    ).rejects.toThrow(BadRequestException);
  });

  it('replaceDefaultFormulaComponents bỏ qua công thức gửi đi và chọn tên chưa trùng', async () => {
    const tx = makeTx([]);
    tx.productFormula.findMany.mockResolvedValueOnce([{ name: 'Công thức 1' }]);
    await replaceDefaultFormulaComponents(tx as any, 9, [comp(11)]);
    expect(tx.productFormula.findFirst).toHaveBeenCalledWith({
      where: { productId: 9, isDefault: true, isExternal: false },
    });
    expect(tx.productFormula.create).toHaveBeenCalledWith({
      data: { productId: 9, name: 'Công thức 2', isDefault: true, sortOrder: 0 },
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
