import { Prisma } from '@prisma/client';
import {
  LarkOrderPriceNotificationService,
  orderPriceWarningSignature,
} from './lark-order-price-notification.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 10,
  productCode: 'SP000344',
  productName: 'Mứt Quất Hồng Bì 1.2kg',
  price: new Prisma.Decimal(140000),
  listPrice: new Prisma.Decimal(145000),
  quantity: new Prisma.Decimal(5),
  unit: 'Hộp',
  ...over,
});

function makeService(opts: { rows?: unknown[]; chatEnv?: string } = {}) {
  const create = jest.fn().mockResolvedValue({ code: 0 });
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(opts.rows ?? [row()]),
    order: {
      findUnique: jest.fn().mockResolvedValue({
        code: 'DH128596',
        createdAt: new Date('2026-11-12T05:13:00Z'),
        priceBookName: 'BẢNG GIÁ BUÔN HCM',
        branch: { name: 'Kho Sài Gòn' },
        customer: { code: 'KH1', name: 'Khách buôn Mr Quân' },
        soldBy: { name: 'Sale A', larkUserId: 'ou_sale' },
        creator: { name: 'Sale A' },
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Người sửa' }) },
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'LARK_ORDER_PRICE_CHAT_ID' ? opts.chatEnv : undefined,
    ),
  };
  const service = new LarkOrderPriceNotificationService(
    { im: { message: { create } } } as any,
    prisma as any,
    config as any,
  );
  return { service, create };
}

describe('LarkOrderPriceNotificationService', () => {
  it('gửi card vào nhóm cảnh báo: SL, giá bán, giá bảng giá, chênh lệch đỏ, tên người bán (không tag)', async () => {
    const { service, create } = makeService();
    await expect(service.notify(10, { action: 'create' })).resolves.toBe(true);
    const arg = create.mock.calls[0][0];
    expect(arg.data.receive_id).toBe('oc_9c5f34c588b0c08e45c0f5fe47053ffa');
    expect(arg.data.msg_type).toBe('interactive');
    const content = arg.data.content as string;
    expect(content).toContain('DH128596');
    expect(content).toContain('BẢNG GIÁ BUÔN HCM');
    expect(content).toContain('SP000344 - Mứt Quất Hồng Bì 1.2kg');
    expect(content).toContain('**SL**');
    expect(content).not.toContain('Hộp');
    expect(content).toContain("<font color='red'>140.000</font>");
    expect(content).toContain('145.000');
    expect(content).toContain("<font color='red'>**-5.000**</font>");
    expect(content).toContain('**Người bán:** Sale A');
    expect(content).not.toContain('<at id=');
  });

  it('env LARK_ORDER_PRICE_CHAT_ID ghi đè nhóm nhận', async () => {
    const { service, create } = makeService({ chatEnv: 'oc_test' });
    await service.notify(10, { action: 'create' });
    expect(create.mock.calls[0][0].data.receive_id).toBe('oc_test');
  });

  it('không lệch giá thì không gửi', async () => {
    const { service, create } = makeService({ rows: [] });
    await expect(service.notify(10, { action: 'create' })).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('sửa đơn mà lệch y như cũ thì không gửi lại; lệch khác thì gửi', async () => {
    const { service, create } = makeService();
    const same = orderPriceWarningSignature([row()] as any);
    await expect(
      service.notify(10, { action: 'update', previousSignature: same }),
    ).resolves.toBe(false);
    await expect(
      service.notify(10, { action: 'update', previousSignature: '[]' }),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.content).toContain('vừa sửa');
  });
});
