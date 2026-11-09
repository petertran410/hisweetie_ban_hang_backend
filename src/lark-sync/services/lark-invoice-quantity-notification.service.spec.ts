import { Prisma } from '@prisma/client';
import {
  LarkInvoiceQuantityNotificationService,
  quantityMismatchSignature,
} from './lark-invoice-quantity-notification.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 10,
  orderCode: 'DH1',
  previousCodes: null,
  productCode: 'SP1',
  productName: 'Trà 500gr',
  unit: 'Gói',
  orderQuantity: new Prisma.Decimal(10),
  previousQuantity: new Prisma.Decimal(0),
  invoiceQuantity: new Prisma.Decimal(8),
  ...over,
});

function makeService(
  opts: { rows?: unknown[]; branchId?: number | null } = {},
) {
  const create = jest.fn().mockResolvedValue({ code: 0 });
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(opts.rows ?? [row()]),
    invoice: {
      findUnique: jest.fn().mockResolvedValue({
        code: 'HD1',
        branchId: opts.branchId === undefined ? 1 : opts.branchId,
        createdAt: new Date('2026-11-10T03:00:00Z'),
        branch: { name: 'Kho Sài Gòn' },
        customer: { code: 'KH1', name: 'Khách A' },
        soldBy: { name: 'Sale A', larkUserId: 'ou_sale' },
        creator: { name: 'Kho A' },
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Người sửa' }) },
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new LarkInvoiceQuantityNotificationService(
    { im: { message: { create } } } as any,
    prisma as any,
    config as any,
  );
  return { service, create, prisma };
}

describe('LarkInvoiceQuantityNotificationService', () => {
  it('gửi card vào nhóm Sài Gòn với hóa đơn chi nhánh 1', async () => {
    const { service, create } = makeService();
    await expect(service.notify(10, { action: 'create' })).resolves.toBe(true);
    const arg = create.mock.calls[0][0];
    expect(arg.data.receive_id).toBe('oc_9779a03a5df2dd1954287479867211b0');
    expect(arg.data.msg_type).toBe('interactive');
    const content = arg.data.content as string;
    expect(content).toContain('HD1');
    expect(content).toContain('DH1');
    expect(content).toContain("<font color='red'>**-2**</font>");
    expect(content).toContain('**Người bán:** <at id=ou_sale></at>');
  });

  it.each([6, 4])('chi nhánh %i gửi vào nhóm Hà Nội', async (branchId) => {
    const { service, create } = makeService({ branchId });
    await service.notify(10, { action: 'create' });
    expect(create.mock.calls[0][0].data.receive_id).toBe(
      'oc_0e3dd987a81729d805d993b20cd71ecf',
    );
  });

  it('chi nhánh khác không gửi', async () => {
    const { service, create } = makeService({ branchId: 3 });
    await expect(service.notify(10, { action: 'create' })).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('không lệch thì không gửi', async () => {
    const { service, create } = makeService({ rows: [] });
    await expect(service.notify(10, { action: 'create' })).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('sửa hóa đơn mà lệch y như cũ thì không gửi lại', async () => {
    const { service, create } = makeService();
    const same = quantityMismatchSignature({
      orderCode: 'DH1',
      previousInvoiceCodes: [],
      items: [
        {
          productCode: 'SP1',
          productName: 'Trà 500gr',
          unit: 'Gói',
          orderQuantity: 10,
          previousQuantity: 0,
          expectedQuantity: 10,
          invoiceQuantity: 8,
        },
      ],
    });
    await expect(
      service.notify(10, { action: 'update', previousSignature: same }),
    ).resolves.toBe(false);
    await expect(
      service.notify(10, { action: 'update', previousSignature: '' }),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('đơn tách giao: so với SL còn lại và ghi hóa đơn trước, dư hiện màu cam', async () => {
    const { service, create } = makeService({
      rows: [
        row({
          previousCodes: ['HD0'],
          orderQuantity: new Prisma.Decimal(1000),
          previousQuantity: new Prisma.Decimal(420),
          invoiceQuantity: new Prisma.Decimal(600),
        }),
      ],
    });
    await service.notify(10, { action: 'create' });
    const content = create.mock.calls[0][0].data.content as string;
    expect(content).toContain('SL đặt còn lại');
    expect(content).toContain('HD0');
    expect(content).toContain('580 Gói');
    expect(content).toContain("<font color='orange'>**+20**</font>");
  });
});
