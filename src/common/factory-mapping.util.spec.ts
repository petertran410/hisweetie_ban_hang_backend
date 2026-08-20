import {
  overlayFactoriesFromMappings,
  pickFactoryByRole,
} from './factory-mapping.util';

const factoryA = { id: 1, code: 'NM0001', name: 'ABC' };
const factoryB = { id: 2, code: 'NM0002', name: 'XYZ' };

describe('pickFactoryByRole', () => {
  const mappings = [
    { role: 'primary', isActive: true, factories: factoryA, priority: 0 },
    { role: 'backup', isActive: true, factories: factoryB, priority: 0 },
    { role: 'primary', isActive: true, factories: factoryB, priority: 1 },
  ];

  it('lấy nhà máy primary ưu tiên nhất (dòng đầu tiên sau khi đã sort)', () => {
    expect(pickFactoryByRole(mappings, 'primary')).toEqual(factoryA);
  });

  it('bỏ qua dòng inactive', () => {
    expect(
      pickFactoryByRole(
        [{ role: 'primary', isActive: false, factories: factoryA }],
        'primary',
      ),
    ).toBeNull();
  });
});

describe('overlayFactoriesFromMappings', () => {
  it('ghi đè cột cũ khi mapping có dữ liệu', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      primaryFactoryId: null,
      backupFactoryId: null,
      primaryFactory: null,
      backupFactory: null,
      factory_products: [
        { role: 'primary', isActive: true, factories: factoryA },
        { role: 'backup', isActive: true, factories: factoryB },
      ],
    });

    expect(product.primaryFactoryId).toBe(1);
    expect(product.backupFactoryId).toBe(2);
    expect(product.primaryFactory).toEqual(factoryA);
    expect(product.backupFactory).toEqual(factoryB);
  });

  it('giữ cột cũ khi mapping trống — không làm mất dữ liệu lịch sử', () => {
    const product = overlayFactoriesFromMappings({
      id: 10,
      primaryFactoryId: 9,
      backupFactoryId: null,
      primaryFactory: { id: 9, name: 'Cũ' },
      backupFactory: null,
      factory_products: [],
    });

    expect(product.primaryFactoryId).toBe(9);
    expect(product.primaryFactory).toEqual({ id: 9, name: 'Cũ' });
  });
});
