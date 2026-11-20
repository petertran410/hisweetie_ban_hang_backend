import { BadRequestException } from '@nestjs/common';
import { PublicPriceService } from './public-price.service';
import {
  guessGroup,
  httpsUrl,
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
    expect(guessGroup('Gấu Lermao - Bột Matcha 500gr')).toBe('pow');
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
        imageId: null,
        brandId: null,
        size: '',
        spec: '',
        unit: '',
      },
      {
        productId: 2,
        group: 'tea',
        visible: true,
        tag: null,
        hidePrice: [],
        name: '',
        desc: '',
        imageId: null,
        brandId: null,
        size: '',
        spec: '',
        unit: '',
      },
    ]);
    expect([c.validFrom, c.validTo]).toEqual(['2026-11-01', '']);
  });

  it('nhóm tuỳ chỉnh: giữ thứ tự, bỏ mã sai/trùng; sản phẩm thuộc nhóm đã xoá về nhóm đầu', () => {
    const c = normalizeConfig({
      groups: [
        { key: 'g1abc', name: ' Bột pha chế ', icon: 'jam' },
        { key: 'tea', name: 'Trà', icon: 'tea', visible: false },
        { key: 'tea', name: 'Trùng' },
        { key: 'Bad Key', name: 'Sai mã' },
        { key: 'g2', name: '', icon: 'lạ' },
      ],
      items: [
        { productId: 1, group: 'tea' },
        { productId: 2, group: 'jam' },
      ],
    });
    expect(c.groups).toEqual([
      { key: 'g1abc', name: 'Bột pha chế', icon: 'jam', visible: true },
      { key: 'tea', name: 'Trà', icon: 'tea', visible: false },
      { key: 'g2', name: 'Nhóm sản phẩm', icon: 'top', visible: true },
    ]);
    expect(c.items.map((it) => it.group)).toEqual(['tea', 'g1abc']);
    // Danh sách rỗng → các nhóm mặc định
    expect(normalizeConfig({ groups: [] }).groups.map((g) => g.key)).toEqual([
      'tea',
      'jam',
      'top',
      'froz',
      'pow',
    ]);
  });

  it('link Zalo: chỉ nhận https://, còn lại thành rỗng', () => {
    expect(httpsUrl('https://zalo.me/0973123230')).toBe(
      'https://zalo.me/0973123230',
    );
    expect(httpsUrl('  https://oa.zalo.me/abc  ')).toBe(
      'https://oa.zalo.me/abc',
    );
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<b>x</b>',
      'http://zalo.me/1',
      'zalo.me/1',
      '//zalo.me/1',
      42,
      null,
    ])
      expect(httpsUrl(bad)).toBe('');
    expect(normalizeConfig({ zaloUrl: 'javascript:alert(1)' }).zaloUrl).toBe(
      '',
    );
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
    images: [{ id: id * 10, image: `https://img/${id}.jpg` }],
    ...over,
  });
  const make = (
    products: unknown[],
    details: unknown[] = [],
    activeBookIds: number[] = [22],
    draft: unknown = {},
  ) => {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
      priceBook: {
        findMany: jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
          Promise.resolve(
            where.id.in
              .filter((id) => activeBookIds.includes(id))
              .map((id) => ({ id })),
          ),
        ),
      },
      priceBookDetail: { findMany: jest.fn().mockResolvedValue(details) },
      publicPricePage: {
        findUnique: jest.fn().mockResolvedValue({ draft }),
        upsert: jest.fn(),
      },
    };
    const svc = new PublicPriceService(
      prisma as never,
      { create: jest.fn() } as never,
    );
    return { svc, prisma };
  };

  it('giá Bắc = giá gốc, giá Nam = bảng giá nguồn; thiếu giá hoặc ẩn giá → Liên hệ', async () => {
    const { svc } = make(
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
    const { svc } = make([
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
    expect(data.groups.map((g) => g.key)).toEqual([
      'tea',
      'jam',
      'froz',
      'pow',
    ]);
    expect(data.publishedAt).toBe('2026-11-20T02:00:00.000Z');
    expect(catalog).toHaveLength(6);
  });

  it('trang public xếp nhóm theo thứ tự cấu hình, kèm tên và kiểu hiển thị', async () => {
    const { svc } = make([product(1), product(2), product(3)]);
    const config = normalizeConfig({
      groups: [
        { key: 'g9', name: 'Bột', icon: 'jam' },
        { key: 'tea', name: 'Trà Lá', icon: 'tea' },
        { key: 'top', name: 'Topping', icon: 'top', visible: false },
      ],
      items: [
        { productId: 1, group: 'tea' },
        { productId: 2, group: 'g9' },
        { productId: 3, group: 'top' },
      ],
    });
    const { data } = await svc.build(config, null);
    expect(data.groups).toEqual([
      { key: 'g9', name: 'Bột', icon: 'jam' },
      { key: 'tea', name: 'Trà Lá', icon: 'tea' },
    ]);
    expect(data.products.map((p) => [p.id, p.group])).toEqual([
      [2, 'g9'],
      [1, 'tea'],
    ]);
  });

  it('ảnh trang public: dùng ảnh đã chọn của chính sản phẩm, ảnh lạ/đã xoá → ảnh chính', async () => {
    const withImages = (id: number) =>
      product(id, {
        images: [
          { id: id * 10, image: `https://img/${id}-chinh.jpg` },
          { id: id * 10 + 1, image: `https://img/${id}-phu.jpg` },
        ],
      });
    const { svc } = make([withImages(1), withImages(2), withImages(3)]);
    const config = normalizeConfig({
      items: [
        { productId: 1, group: 'tea', imageId: 11 },
        // Ảnh 21 thuộc sản phẩm 2, không phải sản phẩm 3
        { productId: 3, group: 'tea', imageId: 21 },
        { productId: 2, group: 'tea', imageId: 999 },
      ],
    });
    const { data, catalog } = await svc.build(config, null);
    expect(data.products.map((p) => [p.id, p.image])).toEqual([
      [1, 'https://img/1-phu.jpg'],
      [3, 'https://img/3-chinh.jpg'],
      [2, 'https://img/2-chinh.jpg'],
    ]);
    expect(catalog.find((c) => c.id === 1)?.images.map((i) => i.id)).toEqual([
      10, 11,
    ]);
  });

  it('ghi đè thương hiệu (chỉ thương hiệu đã cấu hình), khối lượng, quy cách, đơn vị tính', async () => {
    const { svc } = make([
      product(1),
      product(2),
      product(3, { tradeMarkId: 7, tradeMark: { name: 'Amo' } }),
    ]);
    const config = normalizeConfig({
      brands: [
        { tradeMarkId: 86, label: 'LerMao' },
        { tradeMarkId: 5, label: 'Trà Phượng Hoàng' },
        { tradeMarkId: 7, label: 'Amo Pastel', visible: false },
      ],
      items: [
        {
          productId: 1,
          group: 'tea',
          brandId: 5,
          size: '1,2kg',
          spec: '10 Túi/Thùng',
          unit: 'Túi lớn',
        },
        // Thương hiệu 99 chưa cấu hình → giữ thương hiệu của sản phẩm
        { productId: 2, group: 'tea', brandId: 99 },
        // Sản phẩm của thương hiệu đang ẩn vẫn hiện khi chọn thương hiệu khác
        { productId: 3, group: 'tea', brandId: 86 },
      ],
    });
    const { data } = await svc.build(config, null);
    expect(
      data.products.map((p) => [p.id, p.brandId, p.size, p.spec, p.unit]),
    ).toEqual([
      [1, 5, '1,2kg', '10 Túi/Thùng', 'Túi lớn'],
      [2, 86, '1kg', '12 Túi/Thùng', 'Túi'],
      [3, 86, '1kg', '12 Túi/Thùng', 'Túi'],
    ]);
    expect(data.brands).toEqual([
      { id: 86, name: 'LerMao' },
      { id: 5, name: 'Trà Phượng Hoàng' },
    ]);
  });

  it('bảng giá nguồn không tồn tại / đã ngừng → không đọc giá của bảng giá đó, giá thành Liên hệ', async () => {
    const { svc, prisma } = make(
      [product(1)],
      [{ priceBookId: 99, productId: 1, price: 50000 }],
      [],
    );
    const config = normalizeConfig({
      regions: [{ key: 'S', priceBookId: 99 }],
      items: [{ productId: 1, group: 'jam' }],
    });
    const { data, inactiveRegions } = await svc.build(config, null);
    // Không truy vấn giá chi tiết khi không còn bảng giá nào đang hoạt động
    expect(prisma.priceBookDetail.findMany).not.toHaveBeenCalled();
    expect(data.products[0].price).toEqual({ N: 100001, S: null });
    expect(inactiveRegions.map((r) => r.key)).toEqual(['S']);
  });

  it('không cho xuất bản khi bảng giá nguồn đã ngừng hoạt động', async () => {
    const { svc, prisma } = make([product(1)], [], [], {
      regions: [{ key: 'S', priceBookId: 99 }],
      items: [{ productId: 1, group: 'jam' }],
    });
    await expect(svc.publish({ id: 1, name: 'A' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.publicPricePage.upsert).not.toHaveBeenCalled();
  });
});
