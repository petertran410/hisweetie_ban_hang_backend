import { TransfersService } from './transfers.service';

describe('TransfersService default price', () => {
  const makeService = () => {
    const findMany = jest.fn().mockResolvedValue([
      { productId: 115, cost: '42827' },
      { productId: 165, cost: '41715' },
    ]);
    const prisma = { inventory: { findMany } };
    const service = new TransfersService(prisma as any, {} as any, {} as any);
    return { service: service as any, findMany };
  };

  it('dòng thiếu đơn giá lấy giá vốn tại chi nhánh chuyển', async () => {
    const { service, findMany } = makeService();
    const details: any[] = [
      { productId: 115 },
      { productId: 165, price: undefined },
      { productId: 999 },
    ];

    await service.fillMissingPrices(6, details);

    expect(findMany).toHaveBeenCalledWith({
      where: { branchId: 6, productId: { in: [115, 165, 999] } },
      select: { productId: true, cost: true },
    });
    expect(details.map((d) => d.price)).toEqual([42827, 41715, 0]);
  });

  it('giữ nguyên đơn giá người dùng đã nhập (kể cả 0)', async () => {
    const { service, findMany } = makeService();
    const details: any[] = [
      { productId: 115, price: 50000 },
      { productId: 165, price: 0 },
    ];

    await service.fillMissingPrices(6, details);

    expect(findMany).not.toHaveBeenCalled();
    expect(details.map((d) => d.price)).toEqual([50000, 0]);
  });

  it('sửa phiếu: dòng thiếu giá giữ đơn giá đang lưu, dòng mới lấy giá vốn', async () => {
    const { service, findMany } = makeService();
    const details: any[] = [{ productId: 115 }, { productId: 165 }];

    await service.fillMissingPrices(6, details, [
      { productId: 115, sendPrice: '39000' },
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { branchId: 6, productId: { in: [165] } },
      select: { productId: true, cost: true },
    });
    expect(details.map((d) => d.price)).toEqual([39000, 41715]);
  });
});
