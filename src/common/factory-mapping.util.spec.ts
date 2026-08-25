import { overlayFactoriesFromMappings } from './factory-mapping.util';

const factoryA = { id: 1, code: 'NM0001', name: 'ABC' };
const factoryB = { id: 2, code: 'NM0002', name: 'XYZ' };
const factoryC = { id: 3, code: 'NM0003', name: 'DEF' };

const mapping = (
  id: number,
  factoryId: number,
  role: 'primary' | 'backup',
  priority: number,
  factories: unknown,
) => ({ id, factoryId, role, priority, isActive: true, factories });

describe('overlayFactoriesFromMappings', () => {
  it('giữ nguyên nhiều nhà máy chính — không cắt còn 1 như mô hình cũ', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      factory_products: [
        mapping(1, 1, 'primary', 0, factoryA),
        mapping(2, 2, 'primary', 1, factoryB),
        mapping(3, 3, 'backup', 0, factoryC),
      ],
    });

    expect(product.factoryMappings).toHaveLength(3);
    expect(
      product.factoryMappings.filter((m: any) => m.role === 'primary'),
    ).toHaveLength(2);
    expect(
      product.factoryMappings.filter((m: any) => m.role === 'backup'),
    ).toHaveLength(1);
  });

  it('giữ thứ tự ưu tiên và gắn kèm object nhà máy', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      factory_products: [
        mapping(1, 1, 'primary', 0, factoryA),
        mapping(2, 2, 'primary', 1, factoryB),
      ],
    });

    expect(product.factoryMappings[0]).toMatchObject({
      factoryId: 1,
      priority: 0,
      factory: factoryA,
    });
    expect(product.factoryMappings[1]).toMatchObject({
      factoryId: 2,
      priority: 1,
    });
  });

  it('sản phẩm chưa gắn nhà máy → mảng rỗng, không lỗi', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      factory_products: [],
    });
    expect(product.factoryMappings).toEqual([]);
  });

  it('chuyển Decimal sang number để FE dùng thẳng', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      factory_products: [
        {
          ...mapping(1, 1, 'primary', 0, factoryA),
          referencePrice: '12.50',
          moqValue: '2',
          leadtimeDays: 45,
        },
      ],
    });

    expect(product.factoryMappings[0].referencePrice).toBe(12.5);
    expect(product.factoryMappings[0].moqValue).toBe(2);
    expect(product.factoryMappings[0].leadtimeDays).toBe(45);
  });
});
