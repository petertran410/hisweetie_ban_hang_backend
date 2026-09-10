import { BadRequestException } from '@nestjs/common';
import { CustomerDemandService } from './customer-demand.service';

describe('CustomerDemandService', () => {
  const repository = {
    findProducts: jest.fn(),
  };
  const auditLogs = { create: jest.fn() };
  const service = new CustomerDemandService(
    repository as any,
    auditLogs as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findProducts.mockResolvedValue([
      {
        id: 1,
        code: 'SKU-1',
        name: 'Sản phẩm 1',
        unit: 'gói',
        conversionValue: 24,
      },
    ]);
  });

  it('giữ nguyên số lượng khi nhập đơn vị cơ bản', async () => {
    const result = await (service as any).normalizeMonths([
      {
        month: '2026-10',
        lines: [{ productId: 1, quantity: 10, unit: 'BASE' }],
      },
    ]);
    expect(result[0].lines[0]).toMatchObject({
      inputQuantity: 10,
      inputUnit: 'BASE',
      quantityBase: 10,
      conversionValue: 1,
    });
  });

  it('quy đổi số thùng theo conversionValue tại thời điểm nhập', async () => {
    const result = await (service as any).normalizeMonths([
      {
        month: '2026-10',
        lines: [{ productId: 1, quantity: 3, unit: 'CARTON' }],
      },
    ]);
    expect(result[0].lines[0]).toMatchObject({
      inputQuantity: 3,
      inputUnit: 'CARTON',
      quantityBase: 72,
      conversionValue: 24,
    });
  });

  it('bắt buộc lý do khi thay đổi tháng đã Confirmed', async () => {
    const current = {
      months: [
        {
          id: 10,
          demandMonth: new Date('2026-10-01T00:00:00.000Z'),
          status: 'CONFIRMED',
          lines: [
            {
              productId: 1,
              inputQuantity: 10,
              inputUnit: 'BASE',
              quantityBase: 10,
            },
          ],
        },
      ],
    };

    await expect(
      (service as any).normalizeMonths(
        [
          {
            id: 10,
            month: '2026-10',
            lines: [{ productId: 1, quantity: 20, unit: 'BASE' }],
          },
        ],
        current,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('từ chối phiếu trùng tháng', async () => {
    await expect(
      (service as any).normalizeMonths([
        {
          month: '2026-10',
          lines: [{ productId: 1, quantity: 10, unit: 'BASE' }],
        },
        {
          month: '2026-10',
          lines: [{ productId: 1, quantity: 5, unit: 'BASE' }],
        },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('từ chối số lượng không hợp lệ', async () => {
    await expect(
      (service as any).normalizeMonths([
        {
          month: '2026-10',
          lines: [{ productId: 1, quantity: 0, unit: 'BASE' }],
        },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
