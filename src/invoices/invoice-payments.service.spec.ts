import { InvoicePaymentsService } from './invoice-payments.service';

describe('InvoicePaymentsService row locking', () => {
  it('khóa invoice trước khi đọc dữ liệu để tạo payment', async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([{ id: 1 }]);
      }),
      invoice: {
        findUnique: jest.fn().mockImplementation(() => {
          calls.push('read');
          return Promise.resolve(null);
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new InvoicePaymentsService(prisma as any, {} as any);

    await expect(
      service.create({ invoiceId: 1, amount: 10 } as any, 7),
    ).rejects.toThrow('Không tìm thấy hóa đơn');
    expect(calls).toEqual(['lock', 'read']);
  });

  it('khóa invoice liên quan trước khi đọc payment để xóa', async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([]);
      }),
      invoicePayment: {
        findUnique: jest.fn().mockImplementation(() => {
          calls.push('read');
          return Promise.resolve(null);
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new InvoicePaymentsService(prisma as any, {} as any);

    await expect(service.remove(9)).rejects.toThrow('Payment not found');
    expect(calls).toEqual(['lock', 'read']);
  });
});
