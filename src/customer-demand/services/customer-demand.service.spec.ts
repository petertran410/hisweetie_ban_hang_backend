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
    findSummaryMonths: jest.fn(),
    findExportMonths: jest.fn(),
    searchCustomerIds: jest.fn(),
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

  it('lọc Demand theo khoảng tháng cần hàng', async () => {
    repository.findList.mockResolvedValue([[], 0]);

    await service.list({
      monthFrom: '2026-09',
      monthTo: '2026-11',
    } as any);

    expect(repository.findList).toHaveBeenCalledWith(
      {
        months: {
          some: {
            demandMonth: {
              gte: new Date('2026-09-01T00:00:00.000Z'),
              lt: new Date('2026-12-01T00:00:00.000Z'),
            },
          },
        },
      },
      0,
      50,
      [{ createdAt: 'desc' }, { id: 'desc' }],
    );
  });

  it('lọc Demand theo mã, tên hoặc số điện thoại khách hàng', async () => {
    repository.findList.mockResolvedValue([[], 0]);
    repository.searchCustomerIds.mockResolvedValue([7, 9]);

    await service.list({ customerSearch: 'KH005507.1 · NLPC Ngu' } as any);

    expect(repository.searchCustomerIds).toHaveBeenCalledWith(
      'KH005507.1 · NLPC Ngu',
    );
    expect(repository.findList).toHaveBeenCalledWith(
      { customerId: { in: [7, 9] } },
      0,
      50,
      [{ createdAt: 'desc' }, { id: 'desc' }],
    );
  });

  it('cộng số lượng cùng mã của nhiều khách theo từng tháng', async () => {
    repository.findSummaryMonths.mockResolvedValue([
      {
        demandMonth: new Date('2026-10-01T00:00:00.000Z'),
        demand: { customerId: 1, customer: { id: 1, code: 'KH1', name: 'A' } },
        lines: [
          {
            quantityBase: 10,
            product: { id: 11, code: 'SP001', name: 'Nguyên liệu', unit: 'gói' },
          },
        ],
      },
      {
        demandMonth: new Date('2026-10-01T00:00:00.000Z'),
        demand: { customerId: 2, customer: { id: 2, code: 'KH2', name: 'B' } },
        lines: [
          {
            quantityBase: 15,
            product: { id: 11, code: 'SP001', name: 'Nguyên liệu', unit: 'gói' },
          },
        ],
      },
      {
        demandMonth: new Date('2026-11-01T00:00:00.000Z'),
        demand: { customerId: 1, customer: { id: 1, code: 'KH1', name: 'A' } },
        lines: [
          {
            quantityBase: 5,
            product: { id: 11, code: 'SP001', name: 'Nguyên liệu', unit: 'gói' },
          },
        ],
      },
    ]);

    const result = await service.orderSummary({ monthFrom: '2026-10' } as any);

    expect(repository.findSummaryMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CONFIRMED',
        demandMonth: { gte: new Date('2026-10-01T00:00:00.000Z') },
      }),
    );
    expect(result.months).toEqual(['2026-10', '2026-11']);
    expect(result.products[0]).toMatchObject({
      customerCount: 2,
      totalQuantityBase: 30,
      quantities: { '2026-10': 25, '2026-11': 5 },
    });
    expect(result.totals).toEqual({ '2026-10': 25, '2026-11': 5 });
  });

  const customerA = { id: 1, code: 'KH1', name: 'Khách A' };
  const customerB = { id: 2, code: 'KH2', name: 'Nhà Bột' };
  const customerC = { id: 3, code: 'KH3', name: 'Khách C' };
  const powder = { id: 11, code: 'SP001', name: 'Bột kem', unit: 'gói' };
  const sugar = { id: 12, code: 'SP002', name: 'Đường', unit: 'kg' };
  const salt = { id: 13, code: 'SP003', name: 'Muối', unit: 'gói' };
  const pepper = { id: 14, code: 'SP004', name: 'Tiêu', unit: 'gói' };

  function summaryLine(
    product: typeof powder,
    quantityBase: number,
    extra: { inputQuantity?: number; inputUnit?: string } = {},
  ) {
    return {
      quantityBase,
      inputQuantity: extra.inputQuantity ?? quantityBase,
      inputUnit: extra.inputUnit ?? 'BASE',
      product,
    };
  }

  function summaryMonth(
    id: number,
    demandId: number,
    month: string,
    customer: typeof customerA,
    lines: ReturnType<typeof summaryLine>[],
  ) {
    return {
      id,
      demandId,
      demandMonth: new Date(`${month}-01T00:00:00.000Z`),
      demand: { customerId: customer.id, customer },
      lines,
    };
  }

  function groupedFixture() {
    return [
      summaryMonth(1, 10, '2026-09', customerA, [
        summaryLine(powder, 10),
        summaryLine(powder, 2),
        summaryLine(sugar, 4),
      ]),
      summaryMonth(2, 11, '2026-10', customerA, [
        summaryLine(powder, 12, { inputQuantity: 1, inputUnit: 'CARTON' }),
      ]),
      summaryMonth(3, 12, '2026-09', customerB, [summaryLine(salt, 7)]),
      summaryMonth(4, 13, '2026-09', customerC, [summaryLine(pepper, 3)]),
    ];
  }

  it('nhóm sản phẩm dưới từng khách và cộng dòng trùng', async () => {
    repository.findSummaryMonths.mockResolvedValue(groupedFixture());

    const result = await service.customerSummary({} as any);
    const customer = result.groups.find((group) => group.customer.id === 1);

    expect(result.months).toEqual(['2026-09', '2026-10']);
    expect(result.groups.map((group) => group.customer.id)).toEqual([1, 3, 2]);
    expect(customer?.products.map((product) => product.product.code)).toEqual([
      'SP001',
      'SP002',
    ]);
    expect(customer?.products[0]).toMatchObject({
      quantities: { '2026-09': 12, '2026-10': 12 },
      totalQuantityBase: 24,
    });
    expect(customer?.totals).toEqual({ '2026-09': 16, '2026-10': 12 });
    expect(customer?.totalQuantityBase).toBe(28);
    expect(result.totals).toEqual({ '2026-09': 26, '2026-10': 12 });
    expect(result.totalQuantityBase).toBe(38);
  });

  it('giữ hai khách cùng mã thành hai nhóm riêng', async () => {
    repository.findSummaryMonths.mockResolvedValue([
      summaryMonth(1, 10, '2026-09', customerA, [summaryLine(powder, 10)]),
      summaryMonth(2, 11, '2026-09', customerB, [summaryLine(powder, 15)]),
    ]);

    const grouped = await service.customerSummary({} as any);
    const merged = await service.orderSummary({} as any);

    expect(grouped.groups).toHaveLength(2);
    expect(grouped.groups.map((group) => group.products[0].totalQuantityBase)).toEqual([
      10,
      15,
    ]);
    expect(merged.products[0]).toMatchObject({
      customerCount: 2,
      totalQuantityBase: 25,
      quantities: { '2026-09': 25 },
    });
  });

  it('lọc tổng theo khách, sản phẩm, khoảng tháng và trạng thái', async () => {
    repository.findSummaryMonths.mockResolvedValue(groupedFixture());
    repository.searchCustomerIds.mockResolvedValue([2]);

    const byProduct = await service.customerSummary({ search: 'SP002' } as any);
    const byCustomerOrProduct = await service.customerSummary({
      search: 'bột',
    } as any);
    const orderBySearch = await service.orderSummary({ search: 'bột' } as any);
    await service.customerSummary({ customerId: 1 } as any);
    await service.customerSummary({ customerSearch: 'KH2' } as any);
    await service.customerSummary({
      customerId: 1,
      customerSearch: 'KH2',
    } as any);
    await service.customerSummary({
      monthFrom: '2026-09',
      monthTo: '2026-10',
      status: 'CANCELLED',
    } as any);

    expect(byProduct.groups).toHaveLength(1);
    expect(byProduct.groups[0].products.map((item) => item.product.code)).toEqual([
      'SP002',
    ]);
    expect(
      byCustomerOrProduct.groups.map((group) => group.customer.id),
    ).toEqual([1, 2]);
    expect(byCustomerOrProduct.groups[0].products.map((item) => item.product.code)).toEqual([
      'SP001',
    ]);
    expect(byCustomerOrProduct.groups[1].products[0].product.code).toBe('SP003');
    expect(orderBySearch.products.map((item) => item.product.code)).toEqual([
      'SP001',
      'SP003',
    ]);
    expect(orderBySearch.totalQuantityBase).toBe(31);
    expect(repository.findSummaryMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CONFIRMED',
        demand: { customerId: 1 },
      }),
    );
    expect(repository.searchCustomerIds).toHaveBeenCalledWith('KH2');
    expect(repository.findSummaryMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        demand: { customerId: { in: [2] } },
      }),
    );
    expect(repository.findSummaryMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        demand: { customerId: -1 },
      }),
    );
    expect(repository.findSummaryMonths).toHaveBeenCalledWith({
      status: 'CANCELLED',
      demandMonth: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lt: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
  });

  it('xuất tổng quan theo khách và giữ chi tiết từng phiếu', async () => {
    repository.findSummaryMonths.mockResolvedValue([
      summaryMonth(1, 10, '2026-09', customerA, [
        summaryLine(powder, 10),
        summaryLine(powder, 12, { inputQuantity: 1, inputUnit: 'CARTON' }),
      ]),
      summaryMonth(2, 11, '2026-09', customerB, [summaryLine(salt, 7)]),
    ]);
    repository.findExportMonths.mockResolvedValue([
      {
        id: 1,
        demandId: 10,
        demandMonth: new Date('2026-09-01T00:00:00.000Z'),
        status: 'CONFIRMED',
        note: null,
        demand: { note: null, customer: customerA },
        lines: [
          summaryLine(powder, 10),
          summaryLine(powder, 12, { inputQuantity: 1, inputUnit: 'CARTON' }),
        ],
      },
      {
        id: 2,
        demandId: 11,
        demandMonth: new Date('2026-09-01T00:00:00.000Z'),
        status: 'CONFIRMED',
        note: null,
        demand: { note: null, customer: customerB },
        lines: [summaryLine(salt, 7)],
      },
    ]);
    const sendExcel = jest
      .spyOn(service as any, 'sendExcel')
      .mockResolvedValue(undefined);

    await service.exportSummary({ groupBy: 'customer' } as any, {} as any);
    await service.exportDetail({} as any, {} as any);
    await service.exportDetail({ search: 'Nhà Bột' } as any, {} as any);

    const summarySheet = (sendExcel.mock.calls[0][1] as any).worksheets[0];
    const detailSheet = (sendExcel.mock.calls[1][1] as any).worksheets[0];
    const filteredSheet = (sendExcel.mock.calls[2][1] as any).worksheets[0];
    expect(sendExcel.mock.calls[0][2]).toContain('demand-khach-hang-theo-khach-');
    expect(summarySheet.getRow(1).values).toEqual(
      expect.arrayContaining(['Khách hàng', 'Mã hàng', 'Tên hàng', '2026-09']),
    );
    expect(summarySheet.getRow(2).getCell(2).value).toBe('KH1 · Khách A');
    expect(summarySheet.getRow(2).getCell(3).value).toBe('SP001');
    expect(summarySheet.getRow(2).getCell(5).value).toBe(22);
    expect(summarySheet.getRow(3).getCell(4).value).toBe('Tổng Khách A');
    expect(summarySheet.getRow(4).getCell(2).value).toBe('KH2 · Nhà Bột');
    expect(summarySheet.getRow(6).getCell(4).value).toBe('TỔNG');
    expect(summarySheet.getRow(6).getCell(6).value).toBe(29);
    expect(detailSheet.rowCount).toBe(4);
    expect(detailSheet.getRow(2).getCell(2).value).toBe('#10');
    expect(detailSheet.getRow(3).getCell(2).value).toBe('#10');
    expect(detailSheet.getRow(4).getCell(2).value).toBe('#11');
    expect(filteredSheet.rowCount).toBe(2);
    expect(filteredSheet.getRow(2).getCell(3).value).toBe('Nhà Bột');
    sendExcel.mockRestore();
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
