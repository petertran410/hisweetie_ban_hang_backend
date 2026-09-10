import { CustomersService } from './customers.service';
import { INVOICE_STATUS } from '../invoices/dto';

describe('CustomersService.getShippingFeeHistory', () => {
  const buildService = (findManyMock: jest.Mock) => {
    const prisma = {
      invoice: { findMany: findManyMock },
    };
    return new CustomersService(
      prisma as any,
      {} as any,
      {} as any,
    );
  };

  it('trả đúng 5 hóa đơn shippingFee > 0 với source=field', async () => {
    const invoices = Array.from({ length: 5 }, (_, i) => ({
      code: `HD${i + 1}`,
      purchaseDate: new Date(`2026-09-0${5 - i}`),
      shippingFee: 10000 + i * 1000,
      details: [],
    }));
    const service = buildService(jest.fn().mockResolvedValue(invoices));

    const result = await service.getShippingFeeHistory(1);

    expect(result).toHaveLength(5);
    expect(result.every((r) => r.source === 'field')).toBe(true);
    expect(result[0].amount).toBe(10000);
  });

  it('fallback sang item SHIP khi shippingFee = 0 nhưng SHIP > 0', async () => {
    const service = buildService(
      jest.fn().mockResolvedValue([
        {
          code: 'HD-SHIP',
          purchaseDate: new Date('2026-09-05'),
          shippingFee: 0,
          details: [
            { totalPrice: 15000 },
            { totalPrice: 5000 },
          ],
        },
      ]),
    );

    const result = await service.getShippingFeeHistory(1);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('item');
    expect(result[0].amount).toBe(20000);
  });

  it('loại hóa đơn shippingFee = 0 và không có SHIP', async () => {
    const service = buildService(
      jest.fn().mockResolvedValue([
        {
          code: 'HD-ZERO',
          purchaseDate: new Date('2026-09-05'),
          shippingFee: 0,
          details: [],
        },
        {
          code: 'HD-OK',
          purchaseDate: new Date('2026-09-04'),
          shippingFee: 8000,
          details: [],
        },
      ]),
    );

    const result = await service.getShippingFeeHistory(1);

    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('HD-OK');
    expect(result[0].amount).toBe(8000);
  });

  it('chỉ trả tối đa 5 dù có nhiều hơn 5 hóa đơn hợp lệ', async () => {
    const invoices = Array.from({ length: 7 }, (_, i) => ({
      code: `HD${i + 1}`,
      purchaseDate: new Date(`2026-09-0${7 - i}`),
      shippingFee: 5000 + i * 1000,
      details: [],
    }));
    const service = buildService(jest.fn().mockResolvedValue(invoices));

    const result = await service.getShippingFeeHistory(1);

    expect(result).toHaveLength(5);
  });

  it('loại hóa đơn CANCELLED khỏi query', async () => {
    const findManyMock = jest.fn().mockResolvedValue([]);
    const service = buildService(findManyMock);

    await service.getShippingFeeHistory(42);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 42,
          status: { not: INVOICE_STATUS.CANCELLED },
        }),
      }),
    );
  });

  it('trả mảng rỗng khi không có hóa đơn', async () => {
    const service = buildService(jest.fn().mockResolvedValue([]));

    const result = await service.getShippingFeeHistory(99);

    expect(result).toEqual([]);
  });

  it('query lấy buffer 20 và sắp xếp purchaseDate desc', async () => {
    const findManyMock = jest.fn().mockResolvedValue([]);
    const service = buildService(findManyMock);

    await service.getShippingFeeHistory(1);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { purchaseDate: 'desc' },
        take: 20,
      }),
    );
  });
});
