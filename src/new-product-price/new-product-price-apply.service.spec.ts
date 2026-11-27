import { Prisma } from '@prisma/client';
import { NewProductPriceApplyService } from './new-product-price-apply.service';

const D = (n: number) => new Prisma.Decimal(n);

function baseTicket(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    code: 'SPM000007',
    stage: 'DATA',
    status: 'APPROVED',
    productName: 'Siro Đào 750ml',
    parentName: 'Hàng thương hiệu',
    middleName: 'Nhập khẩu chính ngạch',
    childName: 'Siro',
    tradeMarkId: 3,
    tradeMarkName: 'Bibi',
    unit: 'Chai',
    netWeightGram: D(750),
    description: null,
    misaCode: 'MS01',
    cogsHn: D(100000),
    cogsSg: D(105000),
    cogsDt: D(98000),
    priceHnRetail: D(150000),
    priceHnWholesale: D(130000),
    priceSgRetail: null,
    priceSgWholesale: null,
    priceDlcl: null,
    priceShopee: null,
    priceOem: null,
    oemPriceBookId: null,
    oemPriceBookName: null,
    ceoDecision: 'APPROVED',
    productId: null,
    productCode: null,
    images: null,
    documents: null,
    createdById: 10,
    ...overrides,
  } as any;
}

const config = {
  approvers: {
    PURCHASING: [],
    ACCOUNTING: [],
    CHIEF_ACCOUNTANT: [],
    SALES: [],
    CEO: [],
    DATA: [60],
  },
  priceTargets: {
    HN_RETAIL: 'BASE_PRICE',
    HN_WHOLESALE: 11,
    SG_RETAIL: 12,
    SG_WHOLESALE: 13,
    DLCL: null,
    SHOPEE: null,
  },
  costBranches: { HN: [6], SG: [1], DT: [9] },
  remindersEnabled: true,
  defaults: { priceTargets: [], costBranches: [] },
};

function setup(ticket: any) {
  const tx = {
    inventory: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    product: { update: jest.fn().mockResolvedValue({}) },
    priceBookDetail: { upsert: jest.fn().mockResolvedValue({}) },
    newProductPriceTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    newProductPriceEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    category: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    tradeMark: { findUnique: jest.fn().mockResolvedValue({ id: 3 }) },
    unit: { findMany: jest.fn().mockResolvedValue([{ name: 'Chai' }]) },
    product: { count: jest.fn().mockResolvedValue(0) },
    misaInventoryItem: {
      findFirst: jest.fn().mockResolvedValue({
        inventoryItemName: 'Siro Đào (Misa)',
        unitName: 'Chai',
      }),
    },
    factory: {
      findUnique: jest.fn().mockResolvedValue({
        id: 5,
        name: 'Nhà máy Quảng Châu',
        code: 'NM05',
        currency: 'cny',
        isActive: true,
        supplier: { name: 'NCC Hoa Nam' },
      }),
    },
    factory_products: { findUnique: jest.fn().mockResolvedValue(null) },
    branch: {
      findMany: jest.fn().mockResolvedValue([
        { id: 6, name: 'Kho Hà Nội' },
        { id: 1, name: 'Kho Sài Gòn' },
        { id: 9, name: 'CH Diệp Trà' },
      ]),
    },
    priceBook: {
      findMany: jest.fn().mockResolvedValue([
        { id: 11, name: 'Bảng Giá Buôn HN' },
        { id: 12, name: 'Bảng Giá Lẻ HCM' },
        { id: 13, name: 'Bảng Giá Buôn HCM' },
      ]),
    },
    newProductPriceTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const products = {
    create: jest.fn().mockResolvedValue({ id: 500, code: 'SP000500' }),
  };
  const larkSync = { enqueueSync: jest.fn() };
  const notify = { send: jest.fn() };
  const service = {
    getTicketOrThrow: jest.fn().mockResolvedValue(ticket),
    actorOf: (u: any) => ({ id: u.id, isSuperAdmin: false, permissions: [] }),
    audit: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ ok: true }),
  };
  const nppConfig = { get: jest.fn().mockResolvedValue(config) };
  const factoryProducts = { create: jest.fn().mockResolvedValue({ id: 1 }) };
  const svc = new NewProductPriceApplyService(
    prisma,
    nppConfig as any,
    products as any,
    larkSync as any,
    notify as any,
    service as any,
    factoryProducts as any,
  );
  return { svc, prisma, tx, products, larkSync, notify, factoryProducts };
}

const dataUser = { id: 60, name: 'Data' };

describe('NewProductPriceApplyService', () => {
  it('preview: kế hoạch giá vốn + bảng giá, giá HN Lẻ vào Bảng giá chung', async () => {
    const { svc } = setup(baseTicket());
    const preview = await svc.preview(7);
    expect(preview.ok).toBe(true);
    expect(preview.plan.product.basePrice).toBe(150000);
    expect(preview.plan.prices.map((p) => p.priceBookName)).toEqual([
      'Bảng giá chung',
      'Bảng Giá Buôn HN',
    ]);
    expect(preview.plan.costs.find((c) => c.group === 'SG')?.branches).toEqual([
      { id: 1, name: 'Kho Sài Gòn' },
    ]);
  });

  it('preview: báo lỗi khi thương hiệu Lark chưa khớp / giá chưa có bảng giá đích', async () => {
    const { svc } = setup(
      baseTicket({
        tradeMarkId: null,
        tradeMarkName: 'Hiệu lạ',
        priceDlcl: D(120000),
      }),
    );
    const preview = await svc.preview(7);
    expect(preview.ok).toBe(false);
    const messages = preview.issues.map((i) => i.message);
    expect(messages).toContain(
      'Thương hiệu "Hiệu lạ" chưa có trong danh mục POS',
    );
    expect(messages).toContain('Chưa cấu hình bảng giá nhận "Giá ĐLCL"');
  });

  it('preview: nhóm giá vốn chưa có chi nhánh chỉ cảnh báo, không chặn', async () => {
    const { svc } = setup(baseTicket());
    // DT có giá vốn nhưng không có chi nhánh nào (vd POS chưa có cửa hàng Diệp Trà)
    (svc as any).nppConfig.get.mockResolvedValue({
      ...config,
      costBranches: { HN: [6], SG: [1], DT: [] },
    });
    const preview = await svc.preview(7);
    expect(preview.ok).toBe(true);
    expect(preview.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining(
          'Chưa có chi nhánh nhận Giá vốn CH Diệp Trà',
        ),
      }),
    ]);
  });

  it('apply: tạo sản phẩm 1 lần, lưu productId ngay, rồi cập nhật giá vốn/bảng giá và đóng phiếu', async () => {
    const { svc, prisma, tx, products, larkSync, notify } = setup(baseTicket());
    await svc.apply(7, dataUser);

    expect(products.create).toHaveBeenCalledTimes(1);
    const dto = products.create.mock.calls[0][0];
    expect(dto).toMatchObject({
      code: '',
      name: 'Siro Đào 750ml',
      basePrice: 150000,
      purchasePrice: 100000,
      costScope: 'all',
      unit: 'Chai',
      tradeMarkId: 3,
    });
    expect(prisma.newProductPriceTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 500,
          productCode: 'SP000500',
        }),
      }),
    );
    expect(tx.inventory.updateMany).toHaveBeenCalledWith({
      where: { productId: 500, branchId: { in: [1] } },
      data: { cost: 105000 },
    });
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 500 },
      data: {
        misa_code: 'MS01',
        misa_name: 'Siro Đào (Misa)',
        misa_unit: 'Chai',
        basePrice: 150000,
      },
    });
    expect(tx.priceBookDetail.upsert).toHaveBeenCalledTimes(1);
    expect(tx.newProductPriceTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7, stage: 'DATA' },
        data: expect.objectContaining({ stage: 'DONE' }),
      }),
    );
    expect(larkSync.enqueueSync).toHaveBeenCalledWith(500);
    expect(notify.send).toHaveBeenCalledWith('PRODUCT_CREATED', 7, {
      actorId: 60,
    });
  });

  it('apply lại sau lỗi bước 2: không tạo sản phẩm trùng', async () => {
    const { svc, products, tx } = setup(
      baseTicket({ productId: 500, productCode: 'SP000500' }),
    );
    await svc.apply(7, dataUser);
    expect(products.create).not.toHaveBeenCalled();
    expect(tx.priceBookDetail.upsert).toHaveBeenCalled();
  });

  it('apply: người không thuộc Phòng Dữ Liệu bị chặn', async () => {
    const { svc, products } = setup(baseTicket());
    await expect(svc.apply(7, { id: 99, name: 'X' })).rejects.toThrow(
      'Bạn không có quyền áp dụng tạo sản phẩm cho phiếu này',
    );
    expect(products.create).not.toHaveBeenCalled();
  });

  it('apply: tạo sản phẩm lỗi thì nhả khóa để áp dụng lại được', async () => {
    const { svc, prisma, products } = setup(baseTicket());
    products.create.mockRejectedValueOnce(
      new Error('Đơn vị tính không hợp lệ'),
    );
    await expect(svc.apply(7, dataUser)).rejects.toThrow(
      'Đơn vị tính không hợp lệ',
    );
    expect(prisma.newProductPriceTicket.updateMany).toHaveBeenLastCalledWith({
      where: { id: 7, productId: null, appliedById: 60 },
      data: { appliedById: null, appliedByName: null, appliedAt: null },
    });
  });

  it('áp dụng: gắn nhà máy như trang Nhà máy, định lượng đóng gói, đủ mã/tên/đơn vị Misa', async () => {
    const t = baseTicket({
      factoryId: 5,
      supplierId: 2,
      goodsPrice: D(20),
      exchangeRate: D(3884.04),
      moqCartons: D(10),
      packingSpec: D(12),
    });
    const { svc, products, factoryProducts, tx } = setup(t);
    const preview = await svc.preview(7);
    expect(preview.plan.factory).toMatchObject({
      id: 5,
      currency: 'CNY',
      referencePrice: 20,
      exchangeRate: 3884.04,
      moqValue: 10,
      moqUnit: 'CARTON',
    });

    await svc.apply(7, dataUser);
    expect(products.create.mock.calls[0][0].conversionValue).toBe(12);
    expect(factoryProducts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        factoryId: 5,
        productId: 500,
        role: 'primary',
        currency: 'CNY',
        referencePrice: 20,
        exchangeRate: 3884.04,
        moqValue: 10,
        moqUnit: 'CARTON',
        moqBasis: 'QUANTITY',
      }),
      60,
      'Data',
    );
    expect(tx.product.update.mock.calls[0][0].data).toMatchObject({
      misa_code: 'MS01',
      misa_name: 'Siro Đào (Misa)',
      misa_unit: 'Chai',
    });
  });

  it('áp dụng lại khi đã gắn nhà máy: không gắn lần nữa', async () => {
    const t = baseTicket({
      factoryId: 5,
      productId: 500,
      productCode: 'SP000500',
    });
    const { svc, prisma, factoryProducts, products } = setup(t);
    prisma.factory_products.findUnique.mockResolvedValue({ id: 9 });
    await svc.apply(7, dataUser);
    expect(products.create).not.toHaveBeenCalled();
    expect(factoryProducts.create).not.toHaveBeenCalled();
  });

  it('Mã Misa không có trong danh mục Misa → chặn áp dụng', async () => {
    const { svc, prisma } = setup(baseTicket());
    prisma.misaInventoryItem.findFirst.mockResolvedValue(null);
    const preview = await svc.preview(7);
    expect(preview.ok).toBe(false);
    expect(preview.issues.find((i) => i.field === 'misaCode')?.severity).toBe(
      'error',
    );
  });

  it('phiếu Lark chỉ có chữ "NCC - Nhà máy": cảnh báo, không chặn', async () => {
    const { svc } = setup(baseTicket({ supplierFactory: 'Nhà máy ABC' }));
    const preview = await svc.preview(7);
    expect(preview.ok).toBe(true);
    expect(preview.plan.factory).toBeNull();
    expect(preview.issues.find((i) => i.field === 'factoryId')?.severity).toBe(
      'warning',
    );
  });
});
