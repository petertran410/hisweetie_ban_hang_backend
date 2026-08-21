import {
  MoqProductInfo,
  formatMoqSpec,
  measureLine,
  netWeightKgPerPack,
  normalizeMoqSpec,
} from './moq.util';
import { checkMoq } from './moq-check.util';

/** SP mẫu: 1 thùng = 20 gói, mỗi gói 500g tịnh → 1 thùng = 10kg. */
const product: MoqProductInfo = {
  productId: 1,
  productName: 'Trà sữa A',
  conversionValue: 20,
  weight: 500,
  weightUnit: 'g',
};

describe('netWeightKgPerPack', () => {
  it('quy đổi gram sang kg', () => {
    expect(netWeightKgPerPack(product).value).toBe(0.5);
  });

  it('giữ nguyên khi đơn vị là kg', () => {
    expect(
      netWeightKgPerPack({ ...product, weight: 2, weightUnit: 'kg' }).value,
    ).toBe(2);
  });

  it('báo thiếu khi chưa khai khối lượng', () => {
    const r = netWeightKgPerPack({ ...product, weight: null });
    expect(r.value).toBeNull();
    expect(r.issues).toContain('MISSING_WEIGHT');
  });

  it('báo lỗi với đơn vị lạ thay vì đoán bừa', () => {
    const r = netWeightKgPerPack({ ...product, weightUnit: 'lbs' });
    expect(r.value).toBeNull();
    expect(r.issues).toContain('UNKNOWN_WEIGHT_UNIT');
  });
});

describe('measureLine', () => {
  it('PACK: giữ nguyên số gói', () => {
    expect(measureLine(100, 'PACK', product).value).toBe(100);
  });

  it('CARTON: 2000 gói / 20 = 100 thùng', () => {
    expect(measureLine(2000, 'CARTON', product).value).toBe(100);
  });

  it('KG: 2000 gói × 0.5kg = 1000kg', () => {
    expect(measureLine(2000, 'KG', product).value).toBe(1000);
  });

  it('TON: 4000 gói × 0.5kg = 2 tấn', () => {
    expect(measureLine(4000, 'TON', product).value).toBe(2);
  });

  it('CARTON báo thiếu khi chưa khai quy cách', () => {
    const r = measureLine(100, 'CARTON', { ...product, conversionValue: null });
    expect(r.value).toBeNull();
    expect(r.issues).toContain('MISSING_CONVERSION');
  });
});

describe('normalizeMoqSpec', () => {
  it('đọc dữ liệu cũ chỉ có cột moq → QUANTITY/CARTON', () => {
    const spec = normalizeMoqSpec({ moq: 100 }, 'PER_ORDER');
    expect(spec).toMatchObject({
      value: 100,
      basis: 'QUANTITY',
      unit: 'CARTON',
      scope: 'PER_ORDER',
      increment: null,
    });
  });

  it('ưu tiên moqValue hơn moq cũ', () => {
    const spec = normalizeMoqSpec(
      { moq: 100, moqValue: 5, moqBasis: 'WEIGHT', moqUnit: 'TON' },
      'PER_ORDER',
    );
    expect(spec).toMatchObject({ value: 5, basis: 'WEIGHT', unit: 'TON' });
  });

  it('sửa đơn vị không khớp basis về mặc định', () => {
    const spec = normalizeMoqSpec(
      { moqValue: 2, moqBasis: 'WEIGHT', moqUnit: 'CARTON' },
      'PER_LINE',
    );
    expect(spec!.unit).toBe('TON');
  });

  it('trả null khi không khai MOQ', () => {
    expect(normalizeMoqSpec({ moq: null }, 'PER_ORDER')).toBeNull();
    expect(normalizeMoqSpec({ moqValue: 0 }, 'PER_ORDER')).toBeNull();
  });
});

describe('formatMoqSpec', () => {
  it('hiển thị 100 thùng', () => {
    expect(formatMoqSpec(normalizeMoqSpec({ moqValue: 100 }, 'PER_LINE'))).toBe(
      '100 thùng',
    );
  });

  it('hiển thị kèm phạm vi', () => {
    const spec = normalizeMoqSpec(
      {
        moqValue: 5,
        moqBasis: 'WEIGHT',
        moqUnit: 'TON',
        moqScope: 'PER_ORDER',
      },
      'PER_ORDER',
    );
    expect(formatMoqSpec(spec, true)).toBe('5 tấn · Toàn đơn');
  });
});

describe('checkMoq — 3 tình huống nghiệp vụ thực tế', () => {
  const products = new Map([[1, product]]);

  it('case 1: MOQ 100 thùng/sản phẩm — đặt thiếu thì cảnh báo', () => {
    const violations = checkMoq({
      lines: [{ productId: 1, quantity: 1000, factoryId: 9 }], // = 50 thùng
      factorySpecs: new Map([[9, { name: 'Honghe', spec: null }]]),
      mappingSpecs: new Map([
        [
          '9:1',
          normalizeMoqSpec(
            { moqValue: 100, moqBasis: 'QUANTITY', moqUnit: 'CARTON' },
            'PER_LINE',
          ),
        ],
      ]),
      products,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('BELOW_MOQ');
    expect(violations[0].level).toBe('LINE');
    expect(violations[0].missing).toBe(50);
  });

  it('case 2: MOQ 2 tấn/sản phẩm — đủ thì không cảnh báo', () => {
    const violations = checkMoq({
      lines: [{ productId: 1, quantity: 4000, factoryId: 9 }], // = 2 tấn
      factorySpecs: new Map([[9, { name: 'Honghe', spec: null }]]),
      mappingSpecs: new Map([
        [
          '9:1',
          normalizeMoqSpec(
            { moqValue: 2, moqBasis: 'WEIGHT', moqUnit: 'TON' },
            'PER_LINE',
          ),
        ],
      ]),
      products,
    });

    expect(violations).toHaveLength(0);
  });

  it('case 3: MOQ 5 tấn hàng các loại/lần đặt — gom toàn đơn', () => {
    const products2 = new Map([
      [1, product],
      [2, { ...product, productId: 2, productName: 'Trà sữa B' }],
    ]);

    const violations = checkMoq({
      lines: [
        { productId: 1, quantity: 4000, factoryId: 9 }, // 2 tấn
        { productId: 2, quantity: 4000, factoryId: 9 }, // 2 tấn
      ],
      factorySpecs: new Map([
        [
          9,
          {
            name: 'Honghe',
            spec: normalizeMoqSpec(
              {
                moqValue: 5,
                moqBasis: 'WEIGHT',
                moqUnit: 'TON',
                moqScope: 'PER_ORDER',
              },
              'PER_ORDER',
            ),
          },
        ],
      ]),
      mappingSpecs: new Map(),
      products: products2,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].level).toBe('ORDER');
    expect(violations[0].current).toBe(4);
    expect(violations[0].missing).toBe(1);
  });

  it('MOQ nhà máy và MOQ sản phẩm là 2 ràng buộc độc lập', () => {
    const violations = checkMoq({
      lines: [{ productId: 1, quantity: 3000, factoryId: 9 }], // 150 thùng + 1,5 tấn
      factorySpecs: new Map([
        [
          9,
          {
            name: 'Honghe',
            spec: normalizeMoqSpec(
              {
                moqValue: 5,
                moqBasis: 'WEIGHT',
                moqUnit: 'TON',
                moqScope: 'PER_ORDER',
              },
              'PER_ORDER',
            ),
          },
        ],
      ]),
      mappingSpecs: new Map([
        [
          '9:1',
          normalizeMoqSpec(
            { moqValue: 200, moqBasis: 'QUANTITY', moqUnit: 'CARTON' },
            'PER_LINE',
          ),
        ],
      ]),
      products,
    });

    // Vi phạm cả 2 cấp cùng lúc.
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.level).sort()).toEqual(['LINE', 'ORDER']);
  });

  it('cảnh báo bội số khi phần vượt MOQ lệch', () => {
    const violations = checkMoq({
      lines: [{ productId: 1, quantity: 2600, factoryId: 9 }], // 130 thùng
      factorySpecs: new Map([[9, { name: 'Honghe', spec: null }]]),
      mappingSpecs: new Map([
        [
          '9:1',
          normalizeMoqSpec(
            {
              moqValue: 100,
              moqBasis: 'QUANTITY',
              moqUnit: 'CARTON',
              moqIncrement: 20,
            },
            'PER_LINE',
          ),
        ],
      ]),
      products,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('NOT_MULTIPLE_OF_INCREMENT');
    expect(violations[0].missing).toBe(10); // 130 → 140
  });

  it('thiếu khối lượng thì báo DATA_MISSING, không tính sai âm thầm', () => {
    const violations = checkMoq({
      lines: [{ productId: 1, quantity: 4000, factoryId: 9 }],
      factorySpecs: new Map([[9, { name: 'Honghe', spec: null }]]),
      mappingSpecs: new Map([
        [
          '9:1',
          normalizeMoqSpec(
            { moqValue: 2, moqBasis: 'WEIGHT', moqUnit: 'TON' },
            'PER_LINE',
          ),
        ],
      ]),
      products: new Map([[1, { ...product, weight: null }]]),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe('DATA_MISSING');
    expect(violations[0].issues).toContain('MISSING_WEIGHT');
  });
});
