import { LarkSecurityNotificationService } from './lark-security-notification.service';
import {
  SESSION_CREATED,
  SESSION_REVOKED,
  sessionEvents,
} from '../../auth/session/session-events';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const chromeWin =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const setup = (larkUserId: string | null = 'ou_owner') => {
  const client = {
    im: {
      message: { create: jest.fn().mockResolvedValue({ code: 0 }) },
    },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ larkUserId, name: 'Chủ' }),
    },
    authSession: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ userId: 7, userAgent: chromeWin, ip: '5.6.7.8' }),
    },
  };
  const config = { get: () => 'https://pos.example/' };
  const service = new LarkSecurityNotificationService(
    client as any,
    prisma as any,
    config as any,
  );
  service.onModuleInit();
  return { service, client, prisma };
};

describe('LarkSecurityNotificationService', () => {
  it('DMs the account owner on a new-device login', async () => {
    const { service, client } = setup();
    sessionEvents.emit(SESSION_CREATED, {
      userId: 7,
      sessionId: 1,
      userAgent: chromeWin,
      ip: '1.2.3.4',
      newDevice: true,
    });
    await flush();
    service.onModuleDestroy();

    expect(client.im.message.create).toHaveBeenCalledTimes(1);
    const arg = client.im.message.create.mock.calls[0][0];
    expect(arg.params).toEqual({ receive_id_type: 'open_id' });
    expect(arg.data.receive_id).toBe('ou_owner');
    const card = JSON.parse(arg.data.content);
    expect(card.header.title.content).toBe('Đăng nhập trên thiết bị mới');
    const text = card.elements[0].text.content;
    expect(text).toContain('Chrome trên Windows');
    expect(text).toContain('1.2.3.4');
    expect(card.elements[1].actions[0].url).toBe(
      'https://pos.example/cai-dat/thiet-bi',
    );
  });

  it('stays silent for a known device', async () => {
    const { service, client } = setup();
    sessionEvents.emit(SESSION_CREATED, {
      userId: 7,
      sessionId: 1,
      newDevice: false,
    });
    await flush();
    service.onModuleDestroy();
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('sends a red alert when a stolen refresh token is detected', async () => {
    const { service, client } = setup();
    sessionEvents.emit(SESSION_REVOKED, {
      userIds: [],
      sessionIds: [42],
      reason: 'reuse',
    });
    await flush();
    await flush();
    service.onModuleDestroy();
    const card = JSON.parse(
      client.im.message.create.mock.calls[0][0].data.content,
    );
    expect(card.header.template).toBe('red');
    expect(card.elements[0].text.content).toContain('5.6.7.8');
  });

  it('users without a Lark account and Lark errors never throw', async () => {
    const noLark = setup(null);
    await expect(
      noLark.service.notify({ userId: 7, kind: 'new_device', at: new Date() }),
    ).resolves.toBeUndefined();
    expect(noLark.client.im.message.create).not.toHaveBeenCalled();
    noLark.service.onModuleDestroy();

    const failing = setup();
    failing.client.im.message.create.mockRejectedValueOnce(new Error('down'));
    await expect(
      failing.service.notify({ userId: 7, kind: 'new_device', at: new Date() }),
    ).resolves.toBeUndefined();
    failing.service.onModuleDestroy();
  });
});
