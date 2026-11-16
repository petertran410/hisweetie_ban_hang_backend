import { TransfersService } from './transfers.service';

/** Cột "Đang đi đường" ở danh sách hàng hóa. */
describe('TransfersService.getInTransitSummary', () => {
  const createService = (
    rows: { productId: number; sendQuantity: number }[],
  ) => {
    const findMany = jest.fn().mockResolvedValue(rows);
    const service = new TransfersService(
      { transferDetail: { findMany } } as any,
      {} as any,
      {} as any,
    );
    return { service, findMany };
  };

  it('cộng sendQuantity theo sản phẩm, sản phẩm không có phiếu = 0', async () => {
    const { service } = createService([
      { productId: 1, sendQuantity: 24 },
      { productId: 1, sendQuantity: 12 },
      { productId: 2, sendQuantity: 5 },
    ]);

    await expect(service.getInTransitSummary([1, 2, 3], 7)).resolves.toEqual({
      1: 36,
      2: 5,
      3: 0,
    });
  });

  it('chỉ lấy phiếu Đang chuyển (status 2) tới chi nhánh đang chọn', async () => {
    const { service, findMany } = createService([]);

    await service.getInTransitSummary([1], 7);

    expect(findMany.mock.calls[0][0].where).toEqual({
      productId: { in: [1] },
      transfer: { status: 2, toBranchId: 7 },
    });
  });

  it('không chọn chi nhánh → mọi tuyến', async () => {
    const { service, findMany } = createService([]);

    await service.getInTransitSummary([1]);

    expect(findMany.mock.calls[0][0].where.transfer).toEqual({ status: 2 });
  });

  it('không truy vấn khi danh sách sản phẩm rỗng', async () => {
    const { service, findMany } = createService([]);

    await expect(service.getInTransitSummary([])).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });
});
