import { PrintTemplatesService } from './print-templates.service';
import {
  mapProductionExternal,
  PRODUCTION_EXTERNAL,
  PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE,
  PRODUCTION_EXTERNAL_VARIABLES,
} from './production-external-print';

// Phiếu gửi NSX đầy đủ trường tiền — mẫu in không được để lộ trường nào.
const slip = (over: Record<string, unknown> = {}) => ({
  id: 9,
  code: 'GSX0001',
  status: 4,
  manufacturerId: 5,
  sentDate: new Date('2026-11-13T03:00:00Z'),
  createdAt: new Date('2026-11-14T03:00:00Z'),
  sourceBranchName: 'Kho Hà Nội',
  destinationBranchName: 'Kho Sài Gòn',
  sourceBranch: { name: 'Kho Hà Nội', address: '1 Phố Huế', contactNumber: '0900' },
  productCode: 'SP000185',
  productName: 'Trà Phượng Hoàng 500gr',
  product: { unit: 'Gói' },
  quantity: 1000,
  formulaName: 'Công thức 2',
  createdByName: 'Admin',
  note: 'Giao trước 10h\nGọi trước',
  manufacturer: { code: 'NSX01', name: 'NSX Test', contactNumber: '0911', address: 'Bình Dương' },
  // Trường tiền của phiếu (không được in ra).
  materialValue: 59423010,
  processingFee: 500000,
  totalPayable: 51800000,
  batchUnitCost: 111223.01,
  components: [
    { componentCode: 'SP007606', componentName: 'Trà Olong 20Kg', actualGrams: 250000, unit: 'g', unitsDeducted: 12.5, unitCost: 4753840, componentProduct: { unit: 'Thùng' } },
  ],
  manufacturerMaterials: [
    { productId: 1098, productCode: 'SP007587', description: 'Trà Thiết Quan Âm', quantity: 250000, unit: 'g', unitPrice: 205200, priceUnit: 'kg', amount: 51300000, pricingMode: 'UNIT_PRICE' },
  ],
  ...over,
});

describe('production_external print data', () => {
  it('maps slip, manufacturer and own materials without any money field', () => {
    const data = mapProductionExternal(slip());
    expect(data).toMatchObject({
      Ma_Phieu_Gui: 'GSX0001',
      Trang_Thai: 'Đã gửi',
      Ngay_Gui: '13/11/2026',
      Kho_Gui: 'Kho Hà Nội',
      Kho_Nhan: 'Kho Sài Gòn',
      Nha_San_Xuat: 'NSX Test',
      Tong_So_Mat_Hang: '1',
    });
    expect(data.items).toEqual([
      { STT: '1', Ma_Hang: 'SP007606', Ten_Hang_Hoa: 'Trà Olong 20Kg', Luong_Gui: '250,000', Don_Vi_Gui: 'g', So_Luong_Tru_Kho: '12.5', Don_Vi_Tinh: 'Thùng' },
    ]);
    const text = JSON.stringify(data);
    for (const money of ['59423010', '59,423,010', '500,000', '51,800,000', '51,300,000', '205,200', '205200', '4753840', '111223']) {
      expect(text).not.toContain(money);
    }
    // Không key nào là tiền (Tien, Gia, Phi, Cong_No, Thanh_Toan) — so theo từng từ của key.
    expect(Object.keys(data).filter((key) => /(^|_)(Tien|Gia|Phi|Cong_No|Thanh_Toan)(_|$)/.test(key))).toEqual([]);
  });

  it('lists NSX materials with quantity only (no unit price / amount)', () => {
    const { Nguyen_Lieu_NSX } = mapProductionExternal(slip());
    expect(Nguyen_Lieu_NSX).toContain('Trà Thiết Quan Âm');
    expect(Nguyen_Lieu_NSX).toContain('250,000 g');
    expect(Nguyen_Lieu_NSX).not.toMatch(/205|51,300|đ\b/);
    expect(mapProductionExternal(slip({ manufacturerMaterials: [] })).Nguyen_Lieu_NSX).toBe('');
  });

  it('a draft has not deducted stock yet: deduction columns stay blank', () => {
    const data = mapProductionExternal(slip({ status: 1, sentDate: null }));
    expect(data.items[0]).toMatchObject({ So_Luong_Tru_Kho: '', Don_Vi_Tinh: '' });
    expect(data.Ngay_Gui).toBe('14/11/2026');
  });

  it('does not print the finished product, expected output or formula', () => {
    const data = mapProductionExternal(slip());
    const text = JSON.stringify(data);
    for (const hidden of ['Trà Phượng Hoàng', 'SP000185', 'Công thức 2', '1,000']) {
      expect(text).not.toContain(hidden);
    }
    for (const key of ['Thanh_Pham', 'Ma_Thanh_Pham', 'San_Luong_Du_Kien', 'Don_Vi_Thanh_Pham', 'Cong_Thuc']) {
      expect(data).not.toHaveProperty(key);
      expect(PRODUCTION_EXTERNAL_VARIABLES.map((v) => v.key)).not.toContain(key);
      expect(PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE).not.toContain(`{${key}}`);
    }
    expect(PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE).not.toMatch(/Thành phẩm|Sản lượng|Công thức/);
  });

  it('escapes names so product text cannot inject HTML into the print', () => {
    const data = mapProductionExternal(slip({
      manufacturer: { code: 'N1', name: '<b>X</b>' },
      components: [{ componentCode: 'A', componentName: '<img src=x>', actualGrams: 1, unit: 'g', unitsDeducted: 1, componentProduct: { unit: 'Thùng' } }],
    }));
    expect(data.Nha_San_Xuat).toBe('&lt;b&gt;X&lt;/b&gt;');
    expect(data.items[0].Ten_Hang_Hoa).toBe('&lt;img src=x&gt;');
  });

  it('the default template uses only variables declared for this type, none about money', () => {
    const keys = new Set(PRODUCTION_EXTERNAL_VARIABLES.map((v) => v.key));
    const used = [...PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((key) => !keys.has(key))).toEqual([]);
    expect(PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE).not.toMatch(/Tiền|Giá|Phí|Đơn giá|Thành tiền/i);
  });
});

describe('PrintTemplatesService — production_external', () => {
  const service = (templates = 0) => {
    const prisma: any = {
      printTemplate: {
        count: jest.fn().mockResolvedValue(templates),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 1, templateFor: PRODUCTION_EXTERNAL, content: PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE }),
      },
      printTemplateVariable: { findMany: jest.fn().mockResolvedValue([]) },
      production: { findUnique: jest.fn().mockResolvedValue(slip()) },
    };
    return { prisma, svc: new PrintTemplatesService(prisma) };
  };

  it('creates the default template once when the type has none', async () => {
    const { prisma, svc } = service(0);
    await svc.findAll({ templateFor: PRODUCTION_EXTERNAL }, 7);
    expect(prisma.printTemplate.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ templateFor: PRODUCTION_EXTERNAL, code: 'GSX_DEFAULT', isDefault: true, createdBy: 7 })],
      skipDuplicates: true,
    });
    const again = service(1);
    await again.svc.findAll({ templateFor: PRODUCTION_EXTERNAL }, 7);
    expect(again.prisma.printTemplate.createMany).not.toHaveBeenCalled();
  });

  it('exposes the built-in variables to the editor without database rows', async () => {
    const { svc } = service();
    const groups = await svc.getVariables(PRODUCTION_EXTERNAL);
    const keys = Object.values(groups).flat().map((v: any) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['Ma_Phieu_Gui', 'Nha_San_Xuat', 'Luong_Gui', 'Nguyen_Lieu_NSX']));
  });

  it('renders the default template: one row per material, no money in the output', async () => {
    const { svc } = service();
    const { content } = await svc.renderPreview(1, 9);
    expect(content).toContain('PHIẾU GỬI SẢN XUẤT');
    expect(content).toContain('GSX0001');
    expect(content).toContain('250,000 g');
    expect(content).toContain('12.5 Thùng');
    expect(content).toContain('Giao trước 10h<br />Gọi trước');
    expect(content).not.toMatch(/\{[A-Za-z_]+\}/);
    expect(content).not.toMatch(/59,423,010|51,800,000|51,300,000|205,200|500,000/);
  });

  it('refuses an internal production id', async () => {
    const { prisma, svc } = service();
    prisma.production.findUnique.mockResolvedValue({ ...slip(), manufacturerId: null });
    await expect(svc.renderPreview(1, 9)).rejects.toThrow('Không tìm thấy phiếu gửi sản xuất');
  });
});
