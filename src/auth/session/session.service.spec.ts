import { createHash } from 'crypto';
import { SessionService } from './session.service';
import { SESSION_REVOKED, sessionEvents } from './session-events';

type Row = {
  id: number;
  userId: number;
  familyId: string;
  tokenHash: string;
  permissionVersion: number;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  replacedById: number | null;
  lastUsedAt: Date;
};

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Prisma giả lập trong bộ nhớ, đủ cho SessionService. */
function fakePrisma(user: {
  id: number;
  isActive: boolean;
  permissionVersion: number;
}) {
  const rows: Row[] = [];
  let seq = 0;
  const match = (r: Row, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === 'OR') return (v as any[]).some((w) => match(r, w));
      if (v && typeof v === 'object' && 'in' in v)
        return (v.in as unknown[]).includes((r as any)[k]);
      return (r as any)[k] === v;
    });
  const authSession = {
    create: jest.fn(({ data }: any) => {
      const row: Row = {
        id: ++seq,
        revokedAt: null,
        revokeReason: null,
        replacedById: null,
        lastUsedAt: new Date(),
        ...data,
      };
      rows.push(row);
      return Promise.resolve({ id: row.id });
    }),
    findUnique: jest.fn(({ where }: any) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
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
  };
  const prisma: any = {
    authSession,
    user: { findUnique: jest.fn(() => Promise.resolve({ ...user })) },
    $queryRaw: jest.fn(() => Promise.resolve([])),
  };
  prisma.$transaction = (fn: (tx: any) => unknown) => fn(prisma);
  return { prisma, rows, user };
}

describe('SessionService (refresh token rotation)', () => {
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

  it('rotates: new token works, old one is marked rotated', async () => {
    const { service, rows } = setup();
    const first = await service.createSession(7, 2);
    const r = await service.rotate(first.token);
    expect(r.userId).toBe(7);
    expect(r.refresh?.token).toBeDefined();
    expect(r.refresh?.token).not.toBe(first.token);
    expect(rows[0]).toMatchObject({
      revokeReason: 'rotated',
      replacedById: r.sessionId,
    });
    expect(rows[1].familyId).toBe(rows[0].familyId);
    // Token mới dùng tiếp được.
    await expect(service.rotate(r.refresh!.token)).resolves.toBeDefined();
  });

  it('grace window: concurrent tabs reusing the just-rotated token are OK', async () => {
    const { service } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    const b = await service.rotate(first.token); // tab thứ 2, cùng lúc
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.refresh).toBeUndefined(); // không cấp cookie mới
  });

  it('reuse after grace window revokes the whole family (theft)', async () => {
    jest.useFakeTimers();
    const { service, rows } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    jest.advanceTimersByTime(31_000);

    await expect(service.rotate(first.token)).rejects.toMatchObject({
      response: { code: 'SESSION_INVALID' },
    });
    expect(rows.every((r) => r.revokeReason === 'reuse')).toBe(true);
    // Kẻ tấn công lẫn người dùng thật đều bị buộc đăng nhập lại.
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

  it('logout revokes the family; old access token sid becomes unusable', async () => {
    const { service } = setup();
    const first = await service.createSession(7, 2);
    const a = await service.rotate(first.token);
    expect(await service.isSessionUsable(first.sessionId)).toBe(true); // rotated: still OK
    await service.revokeByToken(a.refresh!.token, 'logout');
    expect(await service.isSessionUsable(first.sessionId)).toBe(false);
    expect(await service.isSessionUsable(a.sessionId)).toBe(false);
    await expect(service.rotate(a.refresh!.token)).rejects.toBeDefined();
  });

  it('forceReLogin revokes every session of the user and emits an event', async () => {
    const { service, rows } = setup();
    await service.createSession(7, 2);
    await service.createSession(7, 2); // thiết bị thứ 2
    const listener = jest.fn();
    sessionEvents.on(SESSION_REVOKED, listener);

    await service.forceReLogin([7], 'permission');

    expect(rows.every((r) => r.revokeReason === 'permission')).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      userIds: [7],
      reason: 'permission',
    });
    sessionEvents.off(SESSION_REVOKED, listener);
  });
});
