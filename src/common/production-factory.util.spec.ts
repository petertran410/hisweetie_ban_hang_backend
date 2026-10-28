import {
  assertProductionPurchaseOrder,
  computeWeightedAverageCost,
  getHeldMaterialValue,
  productionFeeInVnd,
  productionValuesFromPurchaseOrder,
  syncProductionFromPurchaseOrders,
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

describe('PN nhận hàng từ phiếu gửi sản xuất', () => {
  const production = {
    id: 9,
    code: 'GSX000009',
    isExternal: true,
    status: 4,
    supplierId: 3,
    destinationBranchId: 1,
    destinationBranchName: 'Kho Hà Nội',
    productId: 50,
    productCode: 'SP050',
    productName: 'Trà túi lọc',
  };
  const makeTx = (overrides: any = {}, existingPo: any = null) => ({
    production: {
      findUnique: jest.fn().mockResolvedValue({ ...production, ...overrides }),
      updateMany: jest.fn(),
    },
    purchaseOrder: { findFirst: jest.fn().mockResolvedValue(existingPo) },
  });
  const validInput = {
    productionId: 9,
    supplierId: 3,
    branchId: 1,
    items: [{ productId: 50, quantity: 940 }],
  };

  it('PN hợp lệ: đúng NCC, đúng kho, đúng 1 dòng thành phẩm', async () => {
    await expect(
      assertProductionPurchaseOrder(makeTx(), validInput),
    ).resolves.toMatchObject({ code: 'GSX000009' });
  });

  it('chặn khi phiếu chưa gửi hoặc đã có PN khác', async () => {
    await expect(
      assertProductionPurchaseOrder(makeTx({ status: 2 }), validInput),
    ).rejects.toThrow('không ở trạng thái Đã gửi');
    await expect(
      assertProductionPurchaseOrder(
        makeTx({}, { code: 'PN000100' }),
        validInput,
      ),
    ).rejects.toThrow('đã có phiếu nhập PN000100');
  });

  it('khi sửa PN thì không kiểm tra trạng thái / PN khác', async () => {
    const tx = makeTx({ status: 2 }, { code: 'PN000100' });
    await expect(
      assertProductionPurchaseOrder(tx, {
        ...validInput,
        excludePurchaseOrderId: 100,
      }),
    ).resolves.toBeTruthy();
    expect(tx.purchaseOrder.findFirst).not.toHaveBeenCalled();
  });

  it('chặn sai NCC, sai kho, thêm sản phẩm khác, hàng loại B, SL 0', async () => {
    const tx = makeTx();
    await expect(
      assertProductionPurchaseOrder(tx, { ...validInput, supplierId: 4 }),
    ).rejects.toThrow('đúng nhà cung cấp');
    await expect(
      assertProductionPurchaseOrder(tx, { ...validInput, branchId: 2 }),
    ).rejects.toThrow('Kho Hà Nội');
    await expect(
      assertProductionPurchaseOrder(tx, {
        ...validInput,
        items: [...validInput.items, { productId: 51, quantity: 1 }],
      }),
    ).rejects.toThrow('chỉ gồm 1 dòng');
    await expect(
      assertProductionPurchaseOrder(tx, {
        ...validInput,
        items: [{ productId: 50, quantity: 940, conditionType: 'damaged' }],
      }),
    ).rejects.toThrow('chỉ gồm 1 dòng');
    await expect(
      assertProductionPurchaseOrder(tx, {
        ...validInput,
        items: [{ productId: 50, quantity: 0 }],
      }),
    ).rejects.toThrow('lớn hơn 0');
  });

  it('phí lấy theo giá trị PN (total − giảm giá), cả CNY', () => {
    const date = new Date('2026-10-28T03:00:00Z');
    expect(
      productionValuesFromPurchaseOrder({
        purchaseDate: date,
        total: '5000000',
        discount: '0',
        currency: 'VND',
        exchangeRate: 1,
        items: [{ quantity: '940' }],
      }),
    ).toEqual({
      receivedQuantity: 940,
      processingFee: 5_000_000,
      feeCurrency: 'VND',
      feeForeignAmount: null,
      feeExchangeRate: null,
      completedDate: date,
    });
    expect(
      productionValuesFromPurchaseOrder({
        purchaseDate: date,
        total: '4403770',
        discount: '0',
        currency: 'CNY',
        exchangeRate: '3567.25',
        items: [{ quantity: '100', factorySubTotal: '1234.5' }],
      }),
    ).toMatchObject({
      processingFee: 4_403_770,
      feeCurrency: 'CNY',
      feeForeignAmount: 1234.5,
      feeExchangeRate: 3567.25,
    });
  });

  const syncTx = (status: number, po: any) => {
    const update = jest.fn();
    return {
      update,
      tx: {
        production: {
          findUnique: jest.fn().mockResolvedValue({
            id: 9,
            isExternal: true,
            status,
            materialValue: '20000000',
            processingFee: '5000000',
          }),
          update,
        },
        purchaseOrder: { findFirst: jest.fn().mockResolvedValue(po) },
      },
    };
  };

  it('có PN đã nhập → Hoàn thành, chép SL/phí/ngày', async () => {
    const date = new Date('2026-10-28T03:00:00Z');
    const { tx, update } = syncTx(4, {
      purchaseDate: date,
      total: '4800000',
      discount: '0',
      currency: 'VND',
      exchangeRate: 1,
      items: [{ quantity: '930' }],
    });
    await syncProductionFromPurchaseOrders(tx, 9);
    expect(tx.purchaseOrder.findFirst.mock.calls[0][0].where).toEqual({
      productionId: 9,
      isDraft: false,
      status: { not: 2 },
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 2,
      receivedQuantity: 930,
      processingFee: 4_800_000,
      completedDate: date,
      totalCost: 24_800_000,
    });
  });

  it('PN bị hủy / về tạm → phiếu quay về Đã gửi', async () => {
    const { tx, update } = syncTx(2, null);
    await syncProductionFromPurchaseOrders(tx, 9);
    expect(update.mock.calls[0][0].data).toEqual({
      status: 4,
      receivedQuantity: null,
      completedDate: null,
      totalCost: 25_000_000,
    });
  });

  it('phiếu đã hủy thì không đụng tới', async () => {
    const { tx, update } = syncTx(3, null);
    await syncProductionFromPurchaseOrders(tx, 9);
    expect(update).not.toHaveBeenCalled();
    expect(tx.purchaseOrder.findFirst).not.toHaveBeenCalled();
  });
});
