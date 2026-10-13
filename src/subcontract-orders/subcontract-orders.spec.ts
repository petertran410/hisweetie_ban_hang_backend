import {
  computeSubcontractTotals,
  computeWeightedAverageCost,
  receiptProcessingAmount,
  SubcontractTotalsInput,
} from '../common/subcontract-order.util';
import { formulaComponentToStockUnits } from './subcontract-material.util';

// Kịch bản chuẩn: gửi 100 kg trà (giá vốn 200.000), nhận 500 + 440 hộp,
// trả 2 kg, phí 15.000/hộp, cước 1.300.000 trả bên thứ ba.
const baseOrder = (
  overrides: Partial<SubcontractTotalsInput> = {},
): SubcontractTotalsInput => ({
  status: 4,
  plannedQuantity: 1000,
  processingUnitPrice: 15000,
  exchangeRate: 1,
  materials: [
    {
      plannedQuantity: 100,
      sentQuantity: 100,
      returnedQuantity: 2,
      unitCost: 200000,
    },
  ],
  receipts: [
    { status: 1, goodQuantity: 500, defectQuantity: 0, amount: 7500000 },
    { status: 1, goodQuantity: 440, defectQuantity: 10, amount: 6600000 },
  ],
  costs: [{ amount: 1300000, isFactoryPayable: false }],
  payments: [],
  ...overrides,
});

describe('computeSubcontractTotals', () => {
  it('tính giá thành = NVL tiêu hao + phí gia công + chi phí khác', () => {
    const t = computeSubcontractTotals(baseOrder());
    expect(t.goodQuantity).toBe(940);
    expect(t.defectQuantity).toBe(10);
    expect(t.materialCost).toBe(19600000);
    expect(t.processingCost).toBe(14100000);
    expect(t.otherCost).toBe(1300000);
    expect(t.totalCost).toBe(35000000);
    expect(t.unitCost).toBeCloseTo(37234.042553, 5);
  });

  it('công nợ nhà máy chỉ gồm phí gia công + chi phí trả cho nhà máy', () => {
    const t = computeSubcontractTotals(
      baseOrder({
        costs: [
          { amount: 1300000, isFactoryPayable: false },
          { amount: 2820000, isFactoryPayable: true },
          { amount: -500000, isFactoryPayable: true },
        ],
      }),
    );
    expect(t.payableAmount).toBe(14100000 + 2820000 - 500000);
    expect(t.totalCost).toBe(35000000 + 2820000 - 500000);
  });

  it('bỏ qua đợt nhập và thanh toán đã hủy', () => {
    const t = computeSubcontractTotals(
      baseOrder({
        receipts: [
          { status: 1, goodQuantity: 500, defectQuantity: 0, amount: 7500000 },
          { status: 2, goodQuantity: 440, defectQuantity: 0, amount: 6600000 },
        ],
        payments: [
          { status: 1, amount: 5000000 },
          { status: 2, amount: 9999999 },
        ],
      }),
    );
    expect(t.goodQuantity).toBe(500);
    expect(t.processingCost).toBe(7500000);
    expect(t.paidAmount).toBe(5000000);
  });

  it('chưa hoàn thành thì chưa có giá thành thực, chỉ có ước tính', () => {
    const t = computeSubcontractTotals(
      baseOrder({
        status: 3,
        materials: [
          {
            plannedQuantity: 100,
            sentQuantity: 100,
            returnedQuantity: 0,
            unitCost: 200000,
          },
        ],
      }),
    );
    expect(t.unitCost).toBe(0);
    // (100 × 200.000 + 1.000 × 15.000 + 1.300.000) / 1.000
    expect(t.estimatedUnitCost).toBe(36300);
  });

  it('lệnh nháp không phát sinh NVL tiêu hao hay công nợ', () => {
    const t = computeSubcontractTotals(
      baseOrder({
        status: 1,
        receipts: [],
        costs: [{ amount: 2000000, isFactoryPayable: true }],
        materials: [
          {
            plannedQuantity: 100,
            sentQuantity: 0,
            returnedQuantity: 0,
            unitCost: 200000,
          },
        ],
      }),
    );
    expect(t.materialCost).toBe(0);
    expect(t.payableAmount).toBe(0);
    expect(t.estimatedUnitCost).toBe(37000);
  });

  it('lệnh đã hủy không còn công nợ nhà máy', () => {
    expect(
      computeSubcontractTotals(baseOrder({ status: 5 })).payableAmount,
    ).toBe(0);
  });
});

describe('receiptProcessingAmount', () => {
  it('quy đổi ngoại tệ và làm tròn đồng', () => {
    expect(receiptProcessingAmount(500, 15000, 1)).toBe(7500000);
    expect(receiptProcessingAmount(333, 4.25, 3567.5)).toBe(5048904);
  });
});

describe('computeWeightedAverageCost', () => {
  it('kho chưa có hàng → lấy giá thành của lệnh', () => {
    expect(
      computeWeightedAverageCost({
        onHand: 940,
        oldCost: 0,
        goodQuantity: 940,
        unitCost: 37234.042553,
      }),
    ).toEqual({ otherQuantity: 0, proposedCost: 37234.04 });
  });

  it('bình quân với tồn cũ đã có giá', () => {
    // 60 hộp cũ giá 40.000 + 940 hộp mới giá 37.234,0426 → 37.400
    expect(
      computeWeightedAverageCost({
        onHand: 1000,
        oldCost: 40000,
        goodQuantity: 940,
        unitCost: 35000000 / 940,
      }),
    ).toEqual({ otherQuantity: 60, proposedCost: 37400 });
  });

  it('tồn cũ chưa định giá (giá 0) không kéo giá mới xuống', () => {
    const r = computeWeightedAverageCost({
      onHand: 2000,
      oldCost: 0,
      goodQuantity: 940,
      unitCost: 37000,
    });
    expect(r.proposedCost).toBe(37000);
  });

  it('đã bán bớt trước khi áp giá → không âm tồn khác', () => {
    const r = computeWeightedAverageCost({
      onHand: 300,
      oldCost: 40000,
      goodQuantity: 940,
      unitCost: 37000,
    });
    expect(r).toEqual({ otherQuantity: 0, proposedCost: 37000 });
  });
});

describe('formulaComponentToStockUnits', () => {
  it('gram: đổi theo trọng lượng 1 đơn vị tồn kho', () => {
    // 105 g trà / hộp, trà tồn theo kg → 1.000 hộp cần 105 kg
    expect(
      formulaComponentToStockUnits(
        {
          quantity: 105,
          inputMode: 'gram',
          componentProduct: { weight: 1, weightUnit: 'kg' },
        },
        1000,
      ),
    ).toBe(105);
  });

  it('piece / carton / không có trọng lượng: nhân thẳng', () => {
    expect(
      formulaComponentToStockUnits(
        { quantity: 1, inputMode: 'piece', componentProduct: { weight: 5 } },
        1000,
      ),
    ).toBe(1000);
    expect(
      formulaComponentToStockUnits(
        { quantity: 1 / 24, inputMode: 'carton', componentProduct: {} },
        48,
      ),
    ).toBe(2);
    expect(
      formulaComponentToStockUnits(
        { quantity: 2, inputMode: 'gram', componentProduct: { weight: 0 } },
        10,
      ),
    ).toBe(20);
  });
});
