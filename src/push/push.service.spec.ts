import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';

type FetchInit = { headers: Record<string, string>; body: string };
type SentMessage = { to: string };

describe('PushService.sendToUsers', () => {
  const prisma = {
    pushDevice: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const config = { get: jest.fn() };
  const fetchMock = jest.fn();
  let service: PushService;

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new PushService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  const okResponse = (data: unknown[]) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  });

  it('không gọi Expo khi user chưa có điện thoại nào', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([]);
    await service.sendToUsers([{ userId: 1, title: 't', body: 'b' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gửi tới mọi điện thoại của đúng user, kèm access token nếu có', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([
      { userId: 1, token: 'ExponentPushToken[a]' },
      { userId: 1, token: 'ExponentPushToken[b]' },
      { userId: 2, token: 'ExponentPushToken[c]' },
    ]);
    config.get.mockReturnValue('secret');
    fetchMock.mockResolvedValue(
      okResponse([{ status: 'ok' }, { status: 'ok' }]),
    );

    await service.sendToUsers([
      { userId: 1, title: 'Đã giao', body: 'HD1', data: { invoiceId: 1 } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as [string, FetchInit])[1];
    expect(init.headers.Authorization).toBe('Bearer secret');
    const sent = JSON.parse(init.body) as SentMessage[];
    expect(sent.map((m) => m.to)).toEqual([
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
    ]);
    expect(sent[0]).toMatchObject({
      title: 'Đã giao',
      body: 'HD1',
      data: { invoiceId: 1 },
      channelId: 'default',
    });
  });

  it('xóa token của máy đã gỡ app (DeviceNotRegistered)', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([
      { userId: 1, token: 'ExponentPushToken[a]' },
      { userId: 1, token: 'ExponentPushToken[b]' },
    ]);
    fetchMock.mockResolvedValue(
      okResponse([
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ]),
    );

    await service.sendToUsers([{ userId: 1, title: 't', body: 'b' }]);

    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['ExponentPushToken[b]'] } },
    });
  });

  it('lỗi mạng không làm hỏng nghiệp vụ gọi tới', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([
      { userId: 1, token: 'ExponentPushToken[a]' },
    ]);
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(
      service.sendToUsers([{ userId: 1, title: 't', body: 'b' }]),
    ).resolves.toBeUndefined();
  });
});
