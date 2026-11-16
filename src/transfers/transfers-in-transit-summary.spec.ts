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

/**
 * Modal tồn kho ở trang Bán hàng gọi không kèm branchId rồi gom theo
 * toBranchId — thiếu field này thì mọi chi nhánh hiện 0.
 */
describe('TransfersService.getInTransitDetailByProduct', () => {
  it('trả toBranchId/fromBranchId, tổng khớp getInTransitSummary', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        sendQuantity: 200,
        receivedQuantity: 0,
        transfer: {
          id: 9,
          code: 'TRF002677',
          fromBranchId: 6,
          toBranchId: 1,
          fromBranchName: 'Kho Hà Nội',
          toBranchName: 'Kho Sài Gòn',
          transferredDate: new Date('2026-11-14T10:41:09Z'),
          createdAt: new Date('2026-11-14T10:40:00Z'),
          status: 2,
        },
      },
    ]);
    const service = new TransfersService(
      { transferDetail: { findMany } } as any,
      {} as any,
      {} as any,
    );

    const res = await service.getInTransitDetailByProduct(7526);

    expect(findMany.mock.calls[0][0].where).toEqual({
      productId: 7526,
      transfer: { status: 2 },
    });
    expect(res.data[0]).toMatchObject({
      code: 'TRF002677',
      fromBranchId: 6,
      toBranchId: 1,
      quantity: 200,
    });
    expect(res.sumQuantity).toBe(200);
  });
});
