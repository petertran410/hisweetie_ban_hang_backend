import { PrintTemplatesService } from './print-templates.service';
import {
  MANUFACTURER_STOCK,
  MANUFACTURER_STOCK_DEFAULT_TEMPLATE,
  MANUFACTURER_STOCK_VARIABLES,
  mapManufacturerStock,
} from './manufacturer-stock-print';

// Phiếu nguyên liệu NSX có đủ giá vốn / giá trị — mẫu in không được để lộ.
const slip = (over: Record<string, unknown> = {}) => ({
  id: 3,
  code: 'GNL1A2B3C4D',
  type: 'SEND',
  status: 1,
  date: new Date('2026-11-18T03:00:00Z'),
  branchId: 2,
  branchName: 'Kho Hà Nội',
  branch: { name: 'Kho Hà Nội', address: '1 Phố Huế', contactNumber: '0900' },
  note: 'Dùng dần cho nhiều mẻ',
  totalValue: 2376920,
  createdByName: 'Admin',
  manufacturer: { code: 'NSX01', name: 'NSX Test', contactNumber: '0911', address: 'Bình Dương' },
  lines: [
    { productCode: 'SP007606', productName: 'Trà Olong 20Kg', quantity: 10000, unit: 'g', units: 0.5, systemUnits: null, unitCost: 4753840, amount: 2376920, product: { unit: 'Thùng' } },
  ],
  ...over,
});

describe('manufacturer_stock print data', () => {
  it('maps a send slip without any money', () => {
    const data = mapManufacturerStock(slip());
    expect(data).toMatchObject({
      Tieu_De: 'PHIẾU GỬI NGUYÊN LIỆU CHO NHÀ SẢN XUẤT', Ma_Phieu: 'GNL1A2B3C4D', Loai_Phieu: 'Gửi nguyên liệu',
      Ngay_Phieu: '18/11/2026', Kho: 'Kho Hà Nội', Nha_San_Xuat: 'NSX Test', Cot_So_Luong: 'Lượng gửi',
      Ben_Giao: 'Người giao hàng', Ben_Nhan: 'Nhà sản xuất nhận',
    });
    expect(data.items).toEqual([{
      STT: '1', Ma_Hang: 'SP007606', Ten_Hang_Hoa: 'Trà Olong 20Kg', So_Luong: '10,000', Don_Vi: 'g',
      Quy_Doi: '0.5', Don_Vi_Kho: 'Thùng', Ton_He_Thong: '',
    }]);
    const text = JSON.stringify(data);
    for (const money of ['4753840', '4,753,840', '2376920', '2,376,920']) expect(text).not.toContain(money);
  });

  it('a return shows the returned quantity as positive; an adjustment shows system stock and signed difference', () => {
    expect(mapManufacturerStock(slip({ type: 'RETURN', lines: [{ productCode: 'A', productName: 'A', quantity: 2, unit: 'kg', units: -0.1, product: { unit: 'Thùng' } }] })))
      .toMatchObject({ Tieu_De: 'PHIẾU NHẬN LẠI NGUYÊN LIỆU TỪ NHÀ SẢN XUẤT', items: [{ So_Luong: '2', Quy_Doi: '0.1' }] });
    const adjust = mapManufacturerStock(slip({
      type: 'ADJUST', branchId: null, branchName: null, branch: null,
      lines: [{ productCode: 'A', productName: 'A', quantity: 1.5, unit: 'kg', units: -0.025, systemUnits: 0.1, product: { unit: 'Thùng' } }],
    }));
    expect(adjust).toMatchObject({ Kho: 'Tồn tại nhà sản xuất', Cot_Quy_Doi: 'Chênh lệch', items: [{ So_Luong: '1.5', Quy_Doi: '−0.025', Ton_He_Thong: '0.1' }] });
  });

  it('an opening-stock declaration prints as a declaration at the manufacturer, without money', () => {
    const data = mapManufacturerStock(slip({
      type: 'OPENING', branchId: null, branchName: null, branch: null,
      lines: [{ productCode: 'A', productName: 'A', quantity: 10, unit: 'kg', units: 0.5, unitCost: 3000000, amount: 1500000, product: { unit: 'Thùng' } }],
    }));
    expect(data).toMatchObject({
      Tieu_De: 'PHIẾU KHAI BÁO TỒN NGUYÊN LIỆU TẠI NHÀ SẢN XUẤT', Loai_Phieu: 'Khai báo tồn đầu', Kho: 'Tồn tại nhà sản xuất',
      items: [{ So_Luong: '10', Don_Vi: 'kg', Quy_Doi: '0.5' }],
    });
    expect(JSON.stringify(data)).not.toMatch(/3,000,000|3000000|1,500,000|1500000/);
  });

  it('returns raw names; the default template only uses declared keys and has no money words', () => {
    const data = mapManufacturerStock(slip({ manufacturer: { code: 'N', name: '<b>X</b>' } }));
    expect(data.Nha_San_Xuat).toBe('<b>X</b>');
    const keys = new Set(MANUFACTURER_STOCK_VARIABLES.map((v) => v.key));
    const used = [...MANUFACTURER_STOCK_DEFAULT_TEMPLATE.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    expect(used.filter((key) => !keys.has(key))).toEqual([]);
    expect(MANUFACTURER_STOCK_DEFAULT_TEMPLATE).not.toMatch(/Tiền|Giá|Phí|Đơn giá|Thành tiền/i);
  });
});

describe('PrintTemplatesService — manufacturer_stock', () => {
  const service = (templates = 0) => {
    const prisma: any = {
      printTemplate: {
        count: jest.fn().mockResolvedValue(templates),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 1, templateFor: MANUFACTURER_STOCK, content: MANUFACTURER_STOCK_DEFAULT_TEMPLATE }),
      },
      printTemplateVariable: { findMany: jest.fn().mockResolvedValue([]) },
      manufacturerStockSlip: { findUnique: jest.fn().mockResolvedValue(slip()) },
    };
    return { prisma, svc: new PrintTemplatesService(prisma) };
  };

  it('creates its own default template once', async () => {
    const { prisma, svc } = service(0);
    await svc.findAll({ templateFor: MANUFACTURER_STOCK }, 7);
    expect(prisma.printTemplate.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ templateFor: MANUFACTURER_STOCK, code: 'GNL_DEFAULT', isDefault: true, createdBy: 7 })],
      skipDuplicates: true,
    });
    const again = service(1);
    await again.svc.findAll({ templateFor: MANUFACTURER_STOCK }, 7);
    expect(again.prisma.printTemplate.createMany).not.toHaveBeenCalled();
  });

  it('renders one row per line with no leftover tokens and no money', async () => {
    const { svc } = service();
    const { content } = await svc.renderPreview(1, 3);
    expect(content).toContain('PHIẾU GỬI NGUYÊN LIỆU CHO NHÀ SẢN XUẤT');
    expect(content).toContain('10,000 g');
    expect(content).toContain('0.5 Thùng');
    expect(content).not.toMatch(/\{[A-Za-z_]+\}/);
    expect(content).not.toMatch(/4,753,840|2,376,920/);
  });

  it('escapes record text exactly once in the rendered print', async () => {
    const { prisma, svc } = service();
    prisma.manufacturerStockSlip.findUnique.mockResolvedValue(slip({
      manufacturer: { code: 'N', name: '<b>X</b> & Co' },
      lines: [{ productCode: 'A', productName: '<img src=x onerror=alert(1)>', quantity: 1, unit: 'g', units: 1, product: { unit: 'Thùng' } }],
    }));
    const { content } = await svc.renderPreview(1, 3);
    expect(content).toContain('&lt;b&gt;X&lt;/b&gt; &amp; Co');
    expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(content).not.toMatch(/&amp;(amp|lt|gt);|<b>X|<img src=x/);
  });

  it('exposes its variables to the editor', async () => {
    const { svc } = service();
    const groups = await svc.getVariables(MANUFACTURER_STOCK);
    const keys = Object.values(groups).flat().map((v: any) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['Ma_Phieu', 'Tieu_De', 'So_Luong', 'Quy_Doi']));
  });
});
