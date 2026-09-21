import { BadRequestException } from '@nestjs/common';
import { CustomerDemandService } from './customer-demand.service';

describe('CustomerDemandService', () => {
  const repository = {
    findList: jest.fn(),
    findProducts: jest.fn(),
    findMonthById: jest.fn(),
    findCustomer: jest.fn(),
    createConfirmed: jest.fn(),
    updateMonth: jest.fn(),
    findById: jest.fn(),
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

  it('cho phép nhiều dòng cùng sản phẩm với đơn vị khác nhau', async () => {
    const result = await (service as any).normalizeMonths([
      {
        month: '2026-10',
        lines: [
          { productId: 1, quantity: 10, unit: 'BASE' },
          { productId: 1, quantity: 2, unit: 'CARTON' },
        ],
      },
    ]);

    expect(result[0].lines).toHaveLength(2);
    expect(result[0].lines[1]).toMatchObject({
      productId: 1,
      inputQuantity: 2,
      inputUnit: 'CARTON',
      quantityBase: 48,
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

  it('từ chối tạo phiếu có nhiều tháng', async () => {
    await expect(
      service.create(
        {
          customerId: 1,
          months: [
            {
              month: '2026-10',
              lines: [{ productId: 1, quantity: 10, unit: 'BASE' }],
            },
            {
              month: '2026-11',
              lines: [{ productId: 1, quantity: 5, unit: 'BASE' }],
            },
          ],
        },
        1,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tạo phiếu Demand một tháng ở trạng thái hoàn thành', async () => {
    repository.findCustomer.mockResolvedValue({
      id: 1,
      code: 'KH001',
      name: 'Khách OEM',
    });
    repository.createConfirmed.mockResolvedValue(99);
    repository.findById.mockResolvedValue({
      id: 99,
      customer: { id: 1, code: 'KH001', name: 'Khách OEM' },
      note: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      months: [],
    });

    await service.create(
      {
        customerId: 1,
        months: [
          {
            month: '2026-10',
            lines: [{ productId: 1, quantity: 10, unit: 'BASE' }],
          },
        ],
      },
      7,
    );

    expect(repository.createConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 1,
        createdBy: 7,
        months: [
          expect.objectContaining({
            demandMonth: new Date('2026-10-01T00:00:00.000Z'),
          }),
        ],
      }),
    );
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

  it('mặc định sắp xếp phiếu Demand theo ngày tạo mới nhất và ẩn ghi chú Lark cũ', async () => {
    repository.findList.mockResolvedValue([
      [
        {
          id: 20,
          customer: { id: 1, code: 'KH001', name: 'Khách OEM' },
          note: 'Đồng bộ tự động từ LarkBase',
          createdAt: new Date('2026-09-20T00:00:00.000Z'),
          updatedAt: new Date('2026-09-21T00:00:00.000Z'),
          months: [],
        },
      ],
      1,
    ]);

    const result = await service.list({} as any);

    expect(repository.findList).toHaveBeenCalledWith(
      {},
      0,
      50,
      [{ createdAt: 'desc' }, { id: 'desc' }],
    );
    expect(result.data[0].note).toBeNull();
    expect(result.data[0].hasSourceDates).toBe(false);
  });

  it('trả ngày nguồn trong chi tiết dòng Lark', async () => {
    const sourceCreatedAt = new Date('2025-08-22T09:01:57.000Z');
    const sourceUpdatedAt = new Date('2025-12-23T07:35:59.000Z');
    repository.findById.mockResolvedValue({
      id: 20,
      sourceSystem: 'LARK',
      customer: { id: 1, code: 'KH001', name: 'Khách OEM' },
      note: null,
      createdAt: sourceCreatedAt,
      updatedAt: sourceUpdatedAt,
      months: [{
        id: 10,
        demandMonth: new Date('2025-09-01T00:00:00.000Z'),
        status: 'CONFIRMED',
        lines: [{
          id: 100,
          productId: 1,
          product: { id: 1, code: 'SKU-1', name: 'Sản phẩm 1' },
          inputQuantity: 10,
          inputUnit: 'BASE',
          quantityBase: 10,
          conversionValue: 1,
          sourceCreatedAt,
          sourceUpdatedAt,
        }],
      }],
    });

    const detail = await service.get(20);

    expect(detail).toMatchObject({
      sourceSystem: 'LARK',
      hasSourceDates: true,
      months: [{
        lines: [{ sourceCreatedAt, sourceUpdatedAt }],
      }],
    });
  });

  it('áp dụng sắp xếp tùy chọn theo tên khách hàng', async () => {
    repository.findList.mockResolvedValue([[], 0]);

    await service.list({
      page: 2,
      limit: 10,
      sortBy: 'customerName',
      sortOrder: 'asc',
    } as any);

    expect(repository.findList).toHaveBeenCalledWith(
      {},
      10,
      10,
      [{ customer: { name: 'asc' } }, { id: 'desc' }],
    );
  });

  it('cập nhật riêng một tháng và giữ hai dòng cùng sản phẩm', async () => {
    repository.findMonthById.mockResolvedValue({
      id: 10,
      demandId: 20,
      demandMonth: new Date('2026-10-01T00:00:00.000Z'),
      status: 'CONFIRMED',
      demand: { id: 20, customerId: 1, note: null },
      lines: [
        {
          id: 100,
          productId: 1,
          inputQuantity: 5,
          inputUnit: 'BASE',
          quantityBase: 5,
        },
      ],
    });
    repository.updateMonth.mockResolvedValue(10);
    repository.findCustomer.mockResolvedValue({
      id: 2,
      code: 'KH002',
      name: 'Khách OEM 2',
    });
    repository.findById.mockResolvedValue({
      id: 20,
      customer: { id: 1, code: 'KH001', name: 'Khách OEM' },
      note: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      months: [
        {
          id: 10,
          demandId: 20,
          demandMonth: new Date('2026-10-01T00:00:00.000Z'),
          status: 'CONFIRMED',
          lines: [],
          changeLogs: [],
        },
      ],
    });

    await service.updateMonth(
      10,
      {
        customerId: 2,
        month: '2026-10',
        changeNote: 'Điều chỉnh khách hàng và số lượng',
        lines: [
          { productId: 1, quantity: 10, unit: 'BASE' },
          { productId: 1, quantity: 2, unit: 'CARTON' },
        ],
      },
      7,
    );

    expect(repository.updateMonth).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        customerId: 2,
        lines: [
          expect.objectContaining({ productId: 1, inputUnit: 'BASE' }),
          expect.objectContaining({ productId: 1, inputUnit: 'CARTON' }),
        ],
      }),
    );
  });
});
