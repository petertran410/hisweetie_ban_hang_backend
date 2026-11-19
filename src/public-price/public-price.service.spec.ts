import { PublicPriceService } from './public-price.service';
import {
  guessGroup,
  normalizeConfig,
  splitProductName,
  stripBrandPrefix,
} from './public-price.util';

describe('public-price util', () => {
  it('tách tên POS: khối lượng, quy cách, đơn vị', () => {
    expect(
      splitProductName('Gấu Lermao - Mứt Đào Vàng 1kg (12 Túi/Thùng)'),
    ).toEqual({
      name: 'Gấu Lermao - Mứt Đào Vàng 1kg',
      size: '1kg',
      spec: '12 Túi/Thùng',
      unit: 'Túi',
    });
    // Ngoặc không phải quy cách thì giữ trong tên
    expect(
      splitProductName(
        "Gấu Lermao - Trân châu ĐEN - Nấu 5' 1kg (BẢO QUẢN TỦ ĐÔNG) (20 Túi/Thùng)",
      ),
    ).toMatchObject({
      name: "Gấu Lermao - Trân châu ĐEN - Nấu 5' 1kg (BẢO QUẢN TỦ ĐÔNG)",
      size: '1kg',
    });
  });

  it('bỏ tiền tố thương hiệu khi trùng tên thương hiệu', () => {
    expect(
      stripBrandPrefix('TRÀ PHƯỢNG HOÀNG - Olong Nhài 500gr', 'Phượng Hoàng'),
    ).toBe('Olong Nhài 500gr');
    expect(stripBrandPrefix('Gấu Lermao - Mứt Vải 1kg', 'Lermao')).toBe(
      'Mứt Vải 1kg',
    );
    expect(stripBrandPrefix('Trà sữa - Nền 1kg', 'Lermao')).toBe(
      'Trà sữa - Nền 1kg',
    );
  });

  it('gợi ý nhóm theo tên', () => {
    expect(
      guessGroup('Gấu Lermao - Trân châu ĐEN 1kg (BẢO QUẢN TỦ ĐÔNG)'),
    ).toBe('froz');
    expect(guessGroup('Gấu Lermao - Siro Nho Xanh 1kg')).toBe('jam');
    expect(guessGroup('TRÀ PHƯỢNG HOÀNG - Olong Nhài 500gr')).toBe('tea');
    expect(guessGroup('Gấu Lermao - Thạch Nổ Dừa 900gr')).toBe('top');
  });

  it('chuẩn hoá cấu hình: bỏ trùng, giá trị sai thành mặc định', () => {
    const c = normalizeConfig({
      regions: [{ key: 'S', priceBookId: 22, hotline: '0908' }, { key: 'X' }],
      items: [
        { productId: 1, group: 'jam', tag: 'hot', hidePrice: ['S', 'Z'] },
        { productId: 1, group: 'tea' },
        { productId: -3 },
        { productId: 2, group: 'zzz', tag: 'boom' },
      ],
      validFrom: '2026-11-01',
      validTo: 'hôm nay',
    });
    expect(c.regions.map((r) => [r.key, r.priceBookId, r.hotline])).toEqual([
      ['N', null, '0973 123 230'],
      ['S', 22, '0908'],
    ]);
    expect(c.items).toEqual([
      {
        productId: 1,
        group: 'jam',
        visible: true,
        tag: 'hot',
        hidePrice: ['S'],
        name: '',
        desc: '',
      },
      {
        productId: 2,
        group: 'top',
        visible: true,
        tag: null,
        hidePrice: [],
        name: '',
        desc: '',
      },
    ]);
    expect([c.validFrom, c.validTo]).toEqual(['2026-11-01', '']);
  });
});

describe('PublicPriceService.build', () => {
  const product = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    code: `SP${id}`,
    name: `Gấu Lermao - Mứt ${id} 1kg (12 Túi/Thùng)`,
    unit: 'Túi',
    basePrice: 100000 + id,
    isActive: true,
    tradeMarkId: 86,
    tradeMark: { name: 'Lermao' },
    images: [{ image: `https://img/${id}.jpg` }],
    ...over,
  });
  const make = (products: unknown[], details: unknown[] = []) => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
      priceBookDetail: { findMany: jest.fn().mockResolvedValue(details) },
    };
    return new PublicPriceService(
      prisma as never,
      { create: jest.fn() } as never,
    );
  };

  it('giá Bắc = giá gốc, giá Nam = bảng giá nguồn; thiếu giá hoặc ẩn giá → Liên hệ', async () => {
    const svc = make(
      [product(1), product(2), product(3)],
      [
        { priceBookId: 22, productId: 1, price: 150000 },
        { priceBookId: 22, productId: 3, price: 130000 },
      ],
    );
    const config = normalizeConfig({
      regions: [{ key: 'S', priceBookId: 22 }],
      items: [
        { productId: 1, group: 'jam' },
        { productId: 2, group: 'jam' },
        { productId: 3, group: 'jam', hidePrice: ['N'] },
      ],
    });
    const { data } = await svc.build(config, null);
    expect(data.products.map((p) => [p.id, p.price.N, p.price.S])).toEqual([
      [1, 100001, 150000],
      [2, 100002, null],
      [3, null, 130000],
    ]);
    expect(data.products[0]).toMatchObject({
      name: 'Mứt 1 1kg',
      size: '1kg',
      spec: '12 Túi/Thùng',
      image: 'https://img/1.jpg',
    });
    expect(data.brands).toEqual([{ id: 86, name: 'LerMao' }]);
  });

  it('bỏ sản phẩm ẩn, ngừng kinh doanh, nhóm ẩn, thương hiệu ẩn; xếp theo nhóm rồi thứ tự cấu hình', async () => {
    const svc = make([
      product(1),
      product(2, { isActive: false }),
      product(3),
      product(4),
      product(5, { tradeMarkId: 5, tradeMark: { name: 'Phượng Hoàng' } }),
      product(6),
    ]);
    const config = normalizeConfig({
      hiddenGroups: ['top'],
      brands: [{ tradeMarkId: 5, visible: false }],
      items: [
        { productId: 1, group: 'jam' },
        { productId: 2, group: 'jam' },
        { productId: 3, group: 'tea', visible: false },
        { productId: 4, group: 'top' },
        { productId: 5, group: 'tea' },
        { productId: 6, group: 'tea' },
      ],
    });
    const { data, catalog } = await svc.build(
      config,
      new Date('2026-11-20T02:00:00Z'),
    );
    expect(data.products.map((p) => p.id)).toEqual([6, 1]);
    expect(data.groups.map((g) => g.key)).toEqual(['tea', 'jam', 'froz']);
    expect(data.publishedAt).toBe('2026-11-20T02:00:00.000Z');
    expect(catalog).toHaveLength(6);
  });
});
