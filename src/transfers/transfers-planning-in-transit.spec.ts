import { TransfersService } from './transfers.service';

/**
 * "Đang chuyển" (inTransit) chỉ đếm phiếu chuyển kho HN → SG ở trạng thái
 * status = 2.
 *
 * Phiếu status = 3 (Đã nhận) nhận thiếu KHÔNG được tính, vì
 * `returnShortageToFromBranch()` đã cộng phần thiếu trở lại tồn kho HN. Đếm
 * lại là double-count, đồng thời thổi phồng availableStockSG và làm SL đề
 * xuất thấp hơn thực tế (bug SP000785 / TRF002407).
 */
describe('TransfersService — inTransit cho Dự kiến chuyển kho HN → SG', () => {
  const HN_BRANCH_ID = 6;
  const SG_BRANCH_ID = 1;

  /** Sản phẩm 1 thùng = 12 đơn vị, hàng thường. */
  const PRODUCT = {
    id: 175,
    code: 'SP000785',
    name: 'Gấu Lermao - Siro Nho Xanh 1kg (12 Túi/Thùng)',
    unit: 'Túi',
    conversionValue: 12,
    parentName: 'Hàng thương hiệu',
    middleName: 'Nhập khẩu chính ngạch',
    childName: 'Mứt',
    cargoType: 'NORMAL',
    tradeMarkId: 86,
    tradeMark: { id: 86, name: 'Lermao' },
  };

  /**
   * Prisma giả lập cho getPlanningSummary. `transferDetails` là toàn bộ dòng
   * chi tiết HN → SG của sản phẩm; mock tự lọc theo `where.transfer.status`
   * đúng như Prisma thật, nên test phản ánh được việc service truy vấn
   * status nào.
   */
  const createService = (
    transferDetails: {
      sendQuantity: number;
      receivedQuantity: number;
      status: number;
    }[],
  ) => {
    const transferDetailFindMany = jest.fn(({ where, select }: any) => {
      const wanted = where?.transfer?.status;
      const matches = transferDetails.filter((d) =>
        typeof wanted === 'number'
          ? d.status === wanted
          : Array.isArray(wanted?.in)
            ? wanted.in.includes(d.status)
            : true,
      );

      return Promise.resolve(
        matches.map((d, i) => {
          const row: any = {
            productId: PRODUCT.id,
            sendQuantity: d.sendQuantity,
          };
          if (select?.receivedQuantity) row.receivedQuantity = d.receivedQuantity;
          if (select?.transfer) {
            row.transfer = {
              id: 2000 + i,
              code: `TRF00${2000 + i}`,
              fromBranchName: 'Kho Hà Nội',
              toBranchName: 'Kho Sài Gòn',
              transferredDate: d.status === 1 ? null : new Date('2026-09-03'),
              createdAt: new Date('2026-09-01'),
              status: d.status,
            };
          }
          return row;
        }),
      );
    });

    const prisma = {
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: HN_BRANCH_ID, name: 'Kho Hà Nội' },
          { id: SG_BRANCH_ID, name: 'Kho Sài Gòn' },
        ]),
      },
      product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
      inventory: { findMany: jest.fn().mockResolvedValue([]) },
      transferDetail: { findMany: transferDetailFindMany },
      orderItem: { groupBy: jest.fn().mockResolvedValue([]) },
      invoiceDetail: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = new TransfersService(
      prisma as any,
      {} as any,
      {} as any,
    );

    return { service, prisma, transferDetailFindMany };
  };

  const getInTransit = async (
    transferDetails: Parameters<typeof createService>[0],
  ) => {
    const { service, transferDetailFindMany } = createService(transferDetails);
    const res = await service.getPlanningSummary({} as any);
    return { inTransit: res.data[0].inTransit, transferDetailFindMany };
  };

  it('bỏ qua phiếu Đã nhận thiếu hàng — shortage đã hoàn về kho HN', async () => {
    // TRF002407: gửi 120, nhận 108 → 12 đơn vị đã được hoàn về tồn HN.
    const { inTransit } = await getInTransit([
      { sendQuantity: 120, receivedQuantity: 108, status: 3 },
    ]);

    expect(inTransit).toBe(0);
  });

  it('chỉ truy vấn status = 2, không mở rộng sang status = 3', async () => {
    const { transferDetailFindMany } = await getInTransit([
      { sendQuantity: 120, receivedQuantity: 108, status: 3 },
    ]);

    const inTransitCall = transferDetailFindMany.mock.calls.find(
      ([args]: any) => args?.where?.transfer?.toBranchId === SG_BRANCH_ID,
    );

    expect(inTransitCall?.[0].where.transfer.status).toBe(2);
  });

  it('tính toàn bộ SL gửi của phiếu Đang chuyển', async () => {
    const { inTransit } = await getInTransit([
      { sendQuantity: 600, receivedQuantity: 0, status: 2 },
    ]);

    expect(inTransit).toBe(600);
  });

  it('không trừ receivedQuantity trên phiếu Đang chuyển có dữ liệu bẩn', async () => {
    // TRF002449 / TRF002448 / TRF002157 lưu receivedQuantity = sendQuantity
    // dù phiếu vẫn ở trạng thái "Đang chuyển" — trừ đi sẽ ra 0 sai.
    const { inTransit } = await getInTransit([
      { sendQuantity: 240, receivedQuantity: 240, status: 2 },
    ]);

    expect(inTransit).toBe(240);
  });

  it('cộng dồn nhiều phiếu Đang chuyển, loại phiếu Đã nhận', async () => {
    const { inTransit } = await getInTransit([
      { sendQuantity: 600, receivedQuantity: 0, status: 2 },
      { sendQuantity: 240, receivedQuantity: 240, status: 2 },
      { sendQuantity: 120, receivedQuantity: 108, status: 3 },
      { sendQuantity: 360, receivedQuantity: 360, status: 3 },
    ]);

    expect(inTransit).toBe(840);
  });

  describe('drill-down khớp với cột hiển thị', () => {
    it('status = 2 không trả về phiếu Đã nhận', async () => {
      const { service } = createService([
        { sendQuantity: 600, receivedQuantity: 0, status: 2 },
        { sendQuantity: 120, receivedQuantity: 108, status: 3 },
      ]);

      const res = await service.getTransfersByProductForPlanning(
        PRODUCT.id,
        2,
      );

      expect(res.total).toBe(1);
      expect(res.data.every((r) => r.status === 2)).toBe(true);
    });

    it('sumQuantity khớp inTransit của cột "Đang chuyển"', async () => {
      const details = [
        { sendQuantity: 600, receivedQuantity: 0, status: 2 },
        { sendQuantity: 240, receivedQuantity: 240, status: 2 },
        { sendQuantity: 120, receivedQuantity: 108, status: 3 },
      ];

      const { inTransit } = await getInTransit(details);
      const { service } = createService(details);
      const drilldown = await service.getTransfersByProductForPlanning(
        PRODUCT.id,
        2,
      );

      expect(drilldown.sumQuantity).toBe(inTransit);
    });

    it('status = 1 chỉ trả về Phiếu tạm', async () => {
      const { service } = createService([
        { sendQuantity: 480, receivedQuantity: 0, status: 1 },
        { sendQuantity: 600, receivedQuantity: 0, status: 2 },
        { sendQuantity: 120, receivedQuantity: 108, status: 3 },
      ]);

      const res = await service.getTransfersByProductForPlanning(
        PRODUCT.id,
        1,
      );

      expect(res.total).toBe(1);
      expect(res.sumQuantity).toBe(480);
      expect(res.data[0].statusLabel).toBe('Phiếu tạm');
    });
  });
});
