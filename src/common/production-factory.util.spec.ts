import {
  computeWeightedAverageCost,
  getHeldMaterialValue,
  getProductionFeeDebtItems,
  productionFeeInVnd,
} from './production-factory.util';

// Kịch bản: gửi 100 kg trà (giá vốn 200.000) = 20.000.000, phí lô 5.000.000,
// nhận về 940 hộp → giá thành 25.000.000 / 940.
describe('computeWeightedAverageCost', () => {
  const unitCost = 25_000_000 / 940;

  it('kho chưa có hàng → giá mới = giá thành của lô', () => {
    expect(
      computeWeightedAverageCost({
        otherQuantity: 0,
        oldCost: 0,
        receivedQuantity: 940,
        unitCost,
      }),
    ).toEqual({ otherQuantity: 0, proposedCost: 26595.74 });
  });

  it('bình quân với tồn cũ đã có giá', () => {
    // (60 × 30.000 + 940 × 26.595,74) / 1.000 = 26.800
    expect(
      computeWeightedAverageCost({
        otherQuantity: 60,
        oldCost: 30000,
        receivedQuantity: 940,
        unitCost,
      }),
    ).toEqual({ otherQuantity: 60, proposedCost: 26800 });
  });

  it('tồn cũ chưa định giá không kéo giá xuống', () => {
    expect(
      computeWeightedAverageCost({
        otherQuantity: 500,
        oldCost: 0,
        receivedQuantity: 940,
        unitCost: 26000,
      }).proposedCost,
    ).toBe(26000);
  });

  it('tồn khác âm (đã bán bớt) được coi là 0', () => {
    expect(
      computeWeightedAverageCost({
        otherQuantity: -200,
        oldCost: 30000,
        receivedQuantity: 940,
        unitCost: 26000,
      }),
    ).toEqual({ otherQuantity: 0, proposedCost: 26000 });
  });
});

describe('productionFeeInVnd', () => {
  it('VND giữ nguyên, ngoại tệ nhân tỷ giá và làm tròn đồng', () => {
    expect(productionFeeInVnd({ currency: 'VND', amount: 5_000_000 })).toBe(
      5_000_000,
    );
    expect(
      productionFeeInVnd({
        currency: 'CNY',
        foreignAmount: 1234.5,
        exchangeRate: 3567.25,
      }),
    ).toBe(4403770);
  });
});

describe('công nợ NCC của phiếu gửi sản xuất', () => {
  it('chỉ phí của phiếu đã hoàn thành tính vào nợ', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 7,
        code: 'GSX000007',
        productName: 'Trà túi lọc',
        processingFee: '5000000',
        completedDate: new Date('2026-10-20T03:00:00Z'),
        updatedAt: new Date('2026-10-21T03:00:00Z'),
        createdAt: new Date('2026-10-01T03:00:00Z'),
        destinationBranchId: 1,
        destinationBranchName: 'Kho Hà Nội',
      },
    ]);
    const items = await getProductionFeeDebtItems(
      { production: { findMany } },
      3,
    );
    expect(findMany.mock.calls[0][0].where).toEqual({
      supplierId: 3,
      isExternal: true,
      status: 2,
      processingFee: { gt: 0 },
    });
    expect(items).toEqual([
      expect.objectContaining({
        code: 'GSX000007',
        amount: 5_000_000,
        date: new Date('2026-10-20T03:00:00Z'),
      }),
    ]);
  });

  it('hàng NCC đang giữ = tổng giá vốn NVL của phiếu Đã gửi, không phải nợ', async () => {
    const aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { materialValue: '20000000' } });
    await expect(
      getHeldMaterialValue({ production: { aggregate } }, 3),
    ).resolves.toBe(20_000_000);
    expect(aggregate.mock.calls[0][0].where).toEqual({
      supplierId: 3,
      isExternal: true,
      status: 4,
    });
  });
});
