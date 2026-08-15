import { NotFoundException } from '@nestjs/common';
import { PublicApiWebhookService } from './public-api-webhook.service';

describe('PublicApiWebhookService', () => {
  const clientId = 'client-uuid';
  const timestamp = new Date('2026-08-14T10:00:00.000Z');

  const createService = (listResult: any = { total: 0, data: [] }) => {
    const prisma: any = {
      publicApiWebhook: {
        findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}),
      },
      publicApiWebhookDelivery: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const publicApiService: any = {
      assertResource: jest.fn((value: string) => value),
      list: jest.fn().mockResolvedValue(listResult),
    };
    return { prisma, publicApiService, service: new PublicApiWebhookService(prisma, publicApiService) };
  };

  const webhook = (overrides: Record<string, unknown> = {}) => ({
    id: 'wh-1', clientId, resource: 'customers', url: 'https://partner.example/hook',
    secret: 'super-secret-value-1234', cursorAt: timestamp, isActive: true, failureCount: 0,
    ...overrides,
  });

  const mockFetch = (impl: any) => {
    (global as any).fetch = jest.fn(impl);
    return (global as any).fetch;
  };

  afterEach(() => {
    delete (global as any).fetch;
    jest.useRealTimers();
  });

  it('không trả secret ra ngoài khi đăng ký', async () => {
    const { service, prisma } = createService();
    prisma.publicApiWebhook.upsert.mockResolvedValue(webhook());

    const result = await service.register(clientId, {
      resource: 'customers', url: 'https://partner.example/hook', secret: 'super-secret-value-1234',
    } as any);

    expect(result.data).not.toHaveProperty('secret');
    expect(result.data).toMatchObject({ hasSecret: true });
  });

  it('bắt đầu mốc quét từ thời điểm đăng ký để không dội lại toàn bộ lịch sử', async () => {
    const { service, prisma } = createService();
    prisma.publicApiWebhook.upsert.mockResolvedValue(webhook());

    await service.register(clientId, { resource: 'customers', url: 'https://partner.example/hook' } as any);

    const { create } = prisma.publicApiWebhook.upsert.mock.calls[0][0];
    expect(create.cursorAt).toBeInstanceOf(Date);
  });

  it('chỉ tiến mốc quét khi đối tác nhận thành công', async () => {
    const { service, prisma } = createService({ total: 1, data: [{ id: 5 }] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([webhook()]);
    mockFetch(async () => ({ ok: true, status: 200 }));

    await service.dispatchPending();

    const update = prisma.publicApiWebhook.update.mock.calls[0][0];
    expect(update.data.cursorAt).toBeInstanceOf(Date);
    expect(update.data.failureCount).toBe(0);
  });

  it('giữ nguyên mốc quét khi gọi thất bại để lô dữ liệu không bị mất', async () => {
    const { service, prisma } = createService({ total: 1, data: [{ id: 5 }] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([webhook()]);
    mockFetch(async () => ({ ok: false, status: 500 }));

    await service.dispatchPending();

    const update = prisma.publicApiWebhook.update.mock.calls[0][0];
    // Tiến mốc khi gửi lỗi sẽ khiến lô này không bao giờ được gửi lại.
    expect(update.data).not.toHaveProperty('cursorAt');
    expect(update.data.failureCount).toEqual({ increment: 1 });
  });

  it('ký payload bằng HMAC SHA-256 để đối tác xác minh nguồn gửi', async () => {
    const { service, prisma } = createService({ total: 1, data: [{ id: 5 }] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([webhook()]);
    const fetchMock = mockFetch(async () => ({ ok: true, status: 200 }));

    await service.dispatchPending();

    const [, init] = fetchMock.mock.calls[0];
    const signature = init.headers['X-Webhook-Signature'];
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('không gọi endpoint khi không có bản ghi nào thay đổi', async () => {
    const { service, prisma } = createService({ total: 0, data: [] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([webhook()]);
    const fetchMock = mockFetch(async () => ({ ok: true, status: 200 }));

    await service.dispatchPending();

    expect(fetchMock).not.toHaveBeenCalled();
    // Vẫn tiến mốc để lần sau không quét lại khoảng thời gian rỗng.
    expect(prisma.publicApiWebhook.update).toHaveBeenCalled();
  });

  it('ghi nhật ký lỗi timeout thay vì để ngoại lệ làm dừng cả vòng quét', async () => {
    const { service, prisma } = createService({ total: 1, data: [{ id: 5 }] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([webhook()]);
    mockFetch(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    await service.dispatchPending();

    const delivery = prisma.publicApiWebhookDelivery.create.mock.calls[0][0].data;
    expect(delivery.success).toBe(false);
    expect(delivery.errorMessage).toContain('5000ms');
  });

  it('một webhook lỗi không được chặn các webhook còn lại', async () => {
    const { service, prisma } = createService({ total: 1, data: [{ id: 5 }] });
    prisma.publicApiWebhook.findMany.mockResolvedValue([
      webhook({ id: 'wh-1' }),
      webhook({ id: 'wh-2' }),
    ]);
    prisma.publicApiWebhookDelivery.create
      .mockRejectedValueOnce(new Error('ghi nhật ký lỗi'))
      .mockResolvedValue({});
    mockFetch(async () => ({ ok: true, status: 200 }));

    await service.dispatchPending();

    expect(prisma.publicApiWebhookDelivery.create).toHaveBeenCalledTimes(2);
  });

  it('không cho client đọc hoặc xoá webhook của client khác', async () => {
    const { service, prisma } = createService();
    prisma.publicApiWebhook.findFirst.mockResolvedValue(null);

    await expect(service.get(clientId, 'wh-other')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.unregister(clientId, 'wh-other')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.publicApiWebhook.delete).not.toHaveBeenCalled();
  });

  it('bỏ qua webhook đã lỗi liên tiếp quá ngưỡng', async () => {
    const { service, prisma } = createService();
    prisma.publicApiWebhook.findMany.mockResolvedValue([]);

    await service.dispatchPending();

    expect(prisma.publicApiWebhook.findMany).toHaveBeenCalledWith({
      where: { isActive: true, failureCount: { lt: 10 } },
    });
  });
});
