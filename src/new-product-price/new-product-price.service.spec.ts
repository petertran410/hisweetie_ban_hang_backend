import { BadRequestException } from '@nestjs/common';
import { NewProductPriceService } from './new-product-price.service';

function setup() {
  const prisma: any = {
    tradeMark: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Almer' }),
    },
    supplier: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'NCC Hoa Nam', isActive: true }),
    },
    factory: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'An Huy',
        isActive: true,
        supplier: { id: 2, name: 'NCC Hoa Nam' },
      }),
    },
  };
  const svc = new NewProductPriceService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc, prisma };
}

describe('normalizeInput — lịch sử thay đổi', () => {
  it('trường chọn từ danh sách ghi tên thay cho ID', async () => {
    const { svc } = setup();
    const { changes } = await svc.normalizeInput(
      { tradeMarkId: 11 } as any,
      {
        tradeMarkId: 3,
        tradeMarkName: 'Bibi',
      } as any,
    );
    expect(changes.tradeMarkId).toEqual({ from: 'Bibi', to: 'Almer' });
  });

  it('chọn nhà máy: lịch sử ghi tên nhà máy, NCC tự điền theo nhà máy', async () => {
    const { svc } = setup();
    const { data, changes } = await svc.normalizeInput(
      { factoryId: 108 } as any,
      {} as any,
    );
    expect(changes.factoryId).toEqual({ from: null, to: 'An Huy' });
    expect(data).toMatchObject({
      factoryId: 108,
      factoryName: 'An Huy',
      supplierId: 2,
      supplierName: 'NCC Hoa Nam',
    });
  });

  it('bỏ chọn: ghi "—" (null), không ghi tên cũ', async () => {
    const { svc } = setup();
    const { changes } = await svc.normalizeInput(
      { factoryId: null } as any,
      {
        factoryId: 108,
        factoryName: 'An Huy',
      } as any,
    );
    expect(changes.factoryId).toEqual({ from: 'An Huy', to: null });
  });

  it('nhà máy không thuộc NCC đã chọn → báo lỗi', async () => {
    const { svc } = setup();
    await expect(
      svc.normalizeInput({ supplierId: 9, factoryId: 108 } as any, {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
