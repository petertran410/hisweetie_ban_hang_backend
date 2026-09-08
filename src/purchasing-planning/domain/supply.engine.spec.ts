import { classifyVehicleSupply } from './supply.engine';

describe('classifyVehicleSupply', () => {
  it('trừ ghép xe có ETA trong kỳ khỏi phần còn lại của đơn', () => {
    const result = classifyVehicleSupply({
      snapshotDate: '2026-08-01',
      horizonDays: 40,
      remainingByOrder: new Map([[10, 100]]),
      vehicleLines: [
        {
          id: 1,
          productId: 9,
          quantity: 40,
          status: 1,
          expectedArrivalDate: '2026-08-15',
          orderSupplierId: 10,
          orderCode: 'NCC-1',
        },
      ],
    });
    expect(result.vehicleConfirmed).toBe(40);
    expect(result.vehicleRisk).toBe(0);
    expect(result.remainingNotOnVehicle).toBe(60);
  });

  it('ghép xe không ETA chỉ vào kịch bản rủi ro, không trừ đề xuất chắc chắn', () => {
    const result = classifyVehicleSupply({
      snapshotDate: '2026-08-01',
      horizonDays: 40,
      remainingByOrder: new Map([[10, 80]]),
      vehicleLines: [
        {
          id: 2,
          productId: 9,
          quantity: 80,
          status: 1,
          expectedArrivalDate: null,
          orderSupplierId: 10,
        },
      ],
    });
    expect(result.vehicleConfirmed).toBe(0);
    expect(result.vehicleRisk).toBe(80);
    expect(result.remainingNotOnVehicle).toBe(0);
  });

  it('bỏ phiếu ghép xe chưa xác nhận', () => {
    const result = classifyVehicleSupply({
      snapshotDate: '2026-08-01',
      horizonDays: 40,
      remainingByOrder: new Map([[10, 50]]),
      vehicleLines: [
        {
          id: 3,
          productId: 9,
          quantity: 50,
          status: 0,
          expectedArrivalDate: '2026-08-10',
          orderSupplierId: 10,
        },
      ],
    });
    expect(result.vehicleConfirmed).toBe(0);
    expect(result.remainingNotOnVehicle).toBe(50);
  });
});
