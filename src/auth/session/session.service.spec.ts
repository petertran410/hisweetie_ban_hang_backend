import { createHash } from 'crypto';
import { SessionService } from './session.service';
import {
  SESSION_CREATED,
  SESSION_REVOKED,
  sessionEvents,
} from './session-events';
import { describeUserAgent } from './user-agent.util';

type Row = Record<string, any> & { id: number };

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Prisma giả lập trong bộ nhớ, đủ cho SessionService. */
function fakePrisma(user: {
  id: number;
  isActive: boolean;
  permissionVersion: number;
}) {
  const rows: Row[] = [];
  let seq = 0;
  const cond = (value: unknown, c: any): boolean => {
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      if ('gt' in c) return (value as Date) > c.gt;
      if ('lt' in c) return value != null && (value as Date) < c.lt;
    }
    return (value ?? null) === c;
  };
  const match = (r: Row, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) =>
      k === 'OR' ? (v as any[]).some((w) => match(r, w)) : cond(r[k], v),
    );
  const authSession = {
    create: jest.fn(({ data }: any) => {
      if (
        data.deviceId &&
        rows.some(
          (r) => r.userId === data.userId && r.deviceId === data.deviceId,
        )
      ) {
        return Promise.reject(
          Object.assign(new Error('unique'), { code: 'P2002' }),
        );
      }
      const row: Row = {
        id: ++seq,
        revokedAt: null,
        revokeReason: null,
        previousTokenHash: null,
        rotatedAt: null,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        ...data,
      };
      rows.push(row);
      return Promise.resolve({ id: row.id });
    }),
    findUnique: jest.fn(({ where }: any) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    findFirst: jest.fn(({ where }: any) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    findMany: jest.fn(({ where }: any) =>
      Promise.resolve(rows.filter((r) => match(r, where))),
    ),
    update: jest.fn(({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
    updateMany: jest.fn(({ where, data }: any) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
    deleteMany: jest.fn(({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (match(rows[i], where)) rows.splice(i, 1);
      }
      return Promise.resolve({ count: before - rows.length });
    }),
  };
  const prisma: any = {
    authSession,
    user: { findUnique: jest.fn(() => Promise.resolve({ ...user })) },
    $queryRaw: jest.fn(() => Promise.resolve([])),
  };
  prisma.$transaction = (fn: (tx: any) => unknown) => fn(prisma);
  return { prisma, rows, user };
}

describe('SessionService (1 device = 1 row, in-place rotation)', () => {
  afterEach(() => jest.useRealTimers());

  const setup = () => {
    const f = fakePrisma({ id: 7, isActive: true, permissionVersion: 2 });
    return { ...f, service: new SessionService(f.prisma) };
  };

  it('stores only the SHA-256 hash of the refresh token', async () => {
    const { service, rows } = setup();
    const issued = await service.createSession(7, 2);
    expect(rows[0].tokenHash).toBe(sha(issued.token));
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  });

  it('rotating many times keeps ONE row and the same session id', async () => {
    const { service, rows } = setup();
    let token = (await service.createSession(7, 2)).token;
    const sessionIds = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const r = await service.rotate(token);
      sessionIds.add(r.sessionId);
      expect(r.refresh?.token).not.toBe(token);
      token = r.refresh!.token;
    }
    expect(rows).toHaveLength(1);
    expect(sessionIds.size).toBe(1);
    expect(rows[0].tokenHash).toBe(sha(token));
    expect(rows[0].revokedAt).toBeNull();
  });

  it('grace window: another tab presenting the previous token is OK', async () => {
    const { service, rows } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    const b = await service.rotate(first.token); // tab thứ 2, cùng lúc
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.refresh).toBeUndefined(); // không cấp cookie mới
    expect(rows).toHaveLength(1);
    await expect(service.rotate(a.refresh!.token)).resolves.toBeDefined();
  });

  it('previous token reused after the grace window → session revoked (theft)', async () => {
    jest.useFakeTimers();
    const { service, rows } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    jest.advanceTimersByTime(31_000);

    const listener = jest.fn();
    sessionEvents.on(SESSION_REVOKED, listener);
    await expect(service.rotate(first.token)).rejects.toMatchObject({
      response: { code: 'SESSION_INVALID' },
    });
    sessionEvents.off(SESSION_REVOKED, listener);

    expect(rows[0].revokeReason).toBe('reuse');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: [rows[0].id], reason: 'reuse' }),
    );
    // Người dùng thật cũng phải đăng nhập lại.
    await expect(service.rotate(a.refresh!.token)).rejects.toBeDefined();
    expect(await service.isSessionUsable(a.sessionId)).toBe(false);
  });

  it('permission change → refresh rejected with PERMISSION_CHANGED', async () => {
    const { service, user } = setup();
    const first = await service.createSession(7, 2);
    user.permissionVersion = 3;
    await expect(service.rotate(first.token)).rejects.toMatchObject({
      response: { code: 'PERMISSION_CHANGED' },
    });
  });

  it('disabled account → refresh rejected', async () => {
    const { service, user } = setup();
    const first = await service.createSession(7, 2);
    user.isActive = false;
    await expect(service.rotate(first.token)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DISABLED' },
    });
  });

  it('expired (idle) session → refresh rejected', async () => {
    jest.useFakeTimers();
    const { service } = setup();
    const first = await service.createSession(7, 2);
    jest.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    await expect(service.rotate(first.token)).rejects.toMatchObject({
      response: { code: 'SESSION_EXPIRED' },
    });
  });

  it('unknown token → SESSION_INVALID', async () => {
    const { service } = setup();
    await expect(service.rotate('nope')).rejects.toMatchObject({
      response: { code: 'SESSION_INVALID' },
    });
  });

  it('logging in again on the same browser replaces the old session row', async () => {
    const { service, rows } = setup();
    const first = await service.createSession(7, 2);
    const second = await service.createSession(7, 2, {
      replaceToken: first.token,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second.sessionId);
    expect(await service.isSessionUsable(first.sessionId)).toBe(false);
    await expect(service.rotate(first.token)).rejects.toBeDefined();
  });

  it('same browser (deviceId) keeps ONE row across logout / forced re-login', async () => {
    const { service, rows } = setup();
    const ctx = { deviceId: 'device-aaaaaaaaaaaaaaaa' };
    const first = await service.createSession(7, 2, ctx);
    await service.revokeByToken(first.token, 'logout'); // cookie refresh bị xoá
    const second = await service.createSession(7, 2, ctx);
    await service.forceReLogin([7], 'permission');
    const third = await service.createSession(7, 2, ctx); // vd đăng nhập Lark

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(third.sessionId);
    expect(rows[0].revokedAt).toBeNull();
    for (const old of [first, second]) {
      expect(await service.isSessionUsable(old.sessionId)).toBe(false);
    }
  });

  it('different users on a shared browser keep separate rows', async () => {
    const { service, rows } = setup();
    const ctx = { deviceId: 'device-sharedpcxxxxxxx' };
    await service.createSession(7, 2, ctx);
    await service.createSession(8, 1, ctx);
    expect(rows.map((r) => r.userId).sort()).toEqual([7, 8]);
  });

  it('other user logging in on the same browser replaces the previous cookie session', async () => {
    const { service, rows } = setup();
    const ctx = { deviceId: 'device-sharedpcxxxxxxx' };
    const mine = await service.createSession(7, 2, ctx);
    await service.createSession(8, 1, { ...ctx, replaceToken: mine.token });
    expect(rows.map((r) => r.userId)).toEqual([8]);
  });

  it('two tabs logging in at once → retry on unique conflict, still one row', async () => {
    const { service, rows, prisma } = setup();
    const ctx = { deviceId: 'device-racexxxxxxxxxxx' };
    await service.createSession(7, 2, ctx);
    // Tab kia chen vào giữa lúc xoá và tạo: lần tạo đầu đụng unique.
    prisma.authSession.create.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' })),
    );
    const issued = await service.createSession(7, 2, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(issued.sessionId);
  });

  describe('SESSION_CREATED newDevice flag', () => {
    const chromeWin =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const safariIphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

    const capture = async (fn: () => Promise<unknown>) => {
      const events: any[] = [];
      const listener = (e: any) => events.push(e);
      sessionEvents.on(SESSION_CREATED, listener);
      try {
        await fn();
      } finally {
        sessionEvents.off(SESSION_CREATED, listener);
      }
      return events;
    };

    it('first login ever → not alerted', async () => {
      const { service } = setup();
      const [e] = await capture(() =>
        service.createSession(7, 2, {
          deviceId: 'd-aaaaaaaaaaaaaaaaaaaa',
          userAgent: chromeWin,
        }),
      );
      expect(e.newDevice).toBe(false);
    });

    it('same browser again → known; another browser → new device', async () => {
      const { service } = setup();
      const home = { deviceId: 'd-homexxxxxxxxxxxxxxx', userAgent: chromeWin };
      await service.createSession(7, 2, home);
      const [again] = await capture(() => service.createSession(7, 2, home));
      expect(again.newDevice).toBe(false);
      const [phone] = await capture(() =>
        service.createSession(7, 2, {
          deviceId: 'd-phonexxxxxxxxxxxxxx',
          userAgent: safariIphone,
        }),
      );
      expect(phone.newDevice).toBe(true);
    });

    it('rollout: a pre-cookie row with the same browser type is not "new"', async () => {
      const { service } = setup();
      await service.createSession(7, 2, { userAgent: chromeWin }); // chưa có hs_did
      const [e] = await capture(() =>
        service.createSession(7, 2, {
          deviceId: 'd-freshxxxxxxxxxxxxxx',
          userAgent: chromeWin,
        }),
      );
      expect(e.newDevice).toBe(false);
    });
  });

  it('refresh binds a pre-cookie row to the browser, so the next login replaces it', async () => {
    const { service, rows } = setup();
    const legacy = await service.createSession(7, 2); // chưa có deviceId
    const ctx = { deviceId: 'device-bindxxxxxxxxxxx' };
    await service.rotate(legacy.token, ctx);
    expect(rows[0].deviceId).toBe(ctx.deviceId);
    await service.createSession(7, 2, ctx);
    expect(rows).toHaveLength(1);
  });

  it('logout revokes the session; its access token sid becomes unusable', async () => {
    const { service } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    expect(await service.isSessionUsable(a.sessionId)).toBe(true);
    await service.revokeByToken(a.refresh!.token, 'logout');
    expect(await service.isSessionUsable(a.sessionId)).toBe(false);
    await expect(service.rotate(a.refresh!.token)).rejects.toBeDefined();
  });

  it('revokeSession only touches sessions of that user', async () => {
    const { service } = setup();
    const mine = await service.createSession(7, 2);
    expect(await service.revokeSession(99, mine.sessionId)).toBe(false);
    expect(await service.isSessionUsable(mine.sessionId)).toBe(true);
    expect(await service.revokeSession(7, mine.sessionId)).toBe(true);
    expect(await service.isSessionUsable(mine.sessionId)).toBe(false);
  });

  it('revokeOtherSessions keeps the current device', async () => {
    const { service } = setup();
    const laptop = await service.createSession(7, 2);
    await service.createSession(7, 2); // điện thoại
    await service.createSession(7, 2); // máy khác
    expect(await service.revokeOtherSessions(7, laptop.sessionId)).toBe(2);
    const active = await service.listActiveSessions(7);
    expect(active.map((s) => s.id)).toEqual([laptop.sessionId]);
  });

  it('forceReLogin revokes every session of the user and emits an event', async () => {
    const { service, rows } = setup();
    await service.createSession(7, 2);
    await service.createSession(7, 2); // thiết bị thứ 2
    const listener = jest.fn();
    sessionEvents.on(SESSION_REVOKED, listener);

    await service.forceReLogin([7], 'permission');

    expect(rows.every((r) => r.revokeReason === 'permission')).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [7], reason: 'permission' }),
    );
    sessionEvents.off(SESSION_REVOKED, listener);
  });

  it('startup removes legacy per-rotation rows but keeps live sessions', async () => {
    const { service, rows } = setup();
    const live = await service.createSession(7, 2);
    rows.push(
      {
        ...rows[0],
        id: 100,
        tokenHash: 'old1',
        revokeReason: 'rotated',
        revokedAt: new Date(),
      },
      {
        ...rows[0],
        id: 101,
        tokenHash: 'old2',
        revokeReason: 'rotated',
        revokedAt: new Date(),
      },
      {
        ...rows[0],
        id: 102,
        tokenHash: 'old3',
        revokeReason: 'replaced',
        revokedAt: new Date(),
      },
    );
    await service.onModuleInit();
    expect(rows.map((r) => r.id)).toEqual([live.sessionId]);
    await expect(service.rotate(live.token)).resolves.toBeDefined();
  });
});

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Windows', deviceType: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', deviceType: 'mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', deviceType: 'mobile' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      { browser: 'Edge', os: 'macOS', deviceType: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/141.0.0 Chrome/135.0.0.0 Safari/537.36',
      { browser: 'Cốc Cốc', os: 'Windows', deviceType: 'desktop' },
    ],
    [
      null,
      { browser: 'Trình duyệt khác', os: 'Không rõ', deviceType: 'desktop' },
    ],
  ])('%s', (ua, expected) => {
    expect(describeUserAgent(ua)).toEqual(expected);
  });
});
