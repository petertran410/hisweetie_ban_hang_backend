import type { Server } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_VERIFY_OPTIONS,
  JWT_ISSUER,
} from '../auth/jwt-secret.util';
import {
  ORDERS_ALL_ROOM,
  ordersBranchRoom,
  RealtimeGateway,
  sessionRoom,
} from './realtime.gateway';

const SECRET = 'test-secret';

type Middleware = (socket: any, next: (err?: Error) => void) => void;

const makeSocket = (token?: unknown) => {
  const rooms = new Set<string>(['sid']);
  return {
    id: 'sid',
    connected: true,
    handshake: { auth: token === undefined ? {} : { token } },
    data: {} as Record<string, unknown>,
    rooms,
    join: jest.fn((r: string) => rooms.add(r)),
    leave: jest.fn((r: string) => rooms.delete(r)),
    disconnect: jest.fn(),
  };
};

const build = (opts: {
  user?: any;
  rejectUser?: boolean;
  branchPerms?: Record<number, string[]>;
}) => {
  // Giống RealtimeModule: verify theo luật access token (iss/aud/thuật toán).
  const jwtService = new JwtService({
    secret: SECRET,
    signOptions: { issuer: JWT_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
    verifyOptions: ACCESS_TOKEN_VERIFY_OPTIONS,
  });
  const jwtStrategy = {
    validate: jest.fn(() =>
      opts.rejectUser
        ? Promise.reject(new Error('inactive'))
        : Promise.resolve(opts.user),
    ),
  };
  const authService = {
    getPermissionsForBranch: jest.fn((_u: number, b: number) =>
      Promise.resolve(opts.branchPerms?.[b] ?? []),
    ),
  };
  const permissionCache = {
    getBranch: jest.fn(() => null),
    setBranch: jest.fn(),
  };
  const gateway = new RealtimeGateway(
    jwtService,
    jwtStrategy as any,
    authService as any,
    permissionCache as any,
  );
  let middleware: Middleware | undefined;
  const server = {
    use: (fn: Middleware) => (middleware = fn),
    fetchSockets: jest.fn(() => Promise.resolve([])),
  };
  gateway.server = server as unknown as Server;
  gateway.afterInit(server as any);

  const runMiddleware = (socket: any) =>
    new Promise<Error | undefined>((resolve) => middleware!(socket, resolve));

  return { gateway, jwtService, runMiddleware, jwtStrategy };
};

const claims = { sub: 7, typ: 'access', sid: 3, pv: 1 };
const accessToken = (jwt: JwtService, extra: object = {}) =>
  jwt.sign({ ...claims, ...extra }, { expiresIn: '1h' });

describe('RealtimeGateway auth', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects a socket without token', async () => {
    const { runMiddleware } = build({ user: { id: 7 } });
    const err = await runMiddleware(makeSocket());
    expect(err?.message).toBe('unauthorized');
  });

  it('rejects a token signed with another secret', async () => {
    const { runMiddleware } = build({ user: { id: 7 } });
    const forged = new JwtService({ secret: 'other' }).sign(claims, {
      issuer: JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    expect((await runMiddleware(makeSocket(forged)))?.message).toBe(
      'unauthorized',
    );
  });

  it('rejects an expired token', async () => {
    const { runMiddleware, jwtService } = build({ user: { id: 7 } });
    const expired = jwtService.sign(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 10 },
      {},
    );
    expect((await runMiddleware(makeSocket(expired)))?.message).toBe(
      'unauthorized',
    );
  });

  it('rejects a non-access token (e.g. refresh/other typ)', async () => {
    const { runMiddleware, jwtService } = build({ user: { id: 7 } });
    const token = jwtService.sign({ ...claims, typ: 'refresh' });
    expect((await runMiddleware(makeSocket(token)))?.message).toBe(
      'unauthorized',
    );
  });

  it('rejects when the account is inactive / permission version changed', async () => {
    const { runMiddleware, jwtService } = build({ rejectUser: true });
    const err = await runMiddleware(makeSocket(accessToken(jwtService)));
    expect(err?.message).toBe('unauthorized');
  });

  it('rejects the legacy 7-day token format (no typ/sid)', async () => {
    const { runMiddleware, jwtService } = build({ user: { id: 7 } });
    const legacy = jwtService.sign(
      { sub: 7, email: 'a@b.c', name: 'A', pv: 1 },
      { expiresIn: '7d' },
    );
    expect((await runMiddleware(makeSocket(legacy)))?.message).toBe(
      'unauthorized',
    );
  });

  it('rejects an access token without iss/aud (issued before they existed)', async () => {
    const { runMiddleware } = build({ user: { id: 7 } });
    const noAudience = new JwtService({ secret: SECRET }).sign(claims, {
      expiresIn: '1h',
    });
    expect((await runMiddleware(makeSocket(noAudience)))?.message).toBe(
      'unauthorized',
    );
  });

  it('rejects a token without sub', async () => {
    const { runMiddleware, jwtService } = build({ user: { id: 7 } });
    const token = jwtService.sign({ typ: 'access', sid: 3, pv: 1 });
    expect((await runMiddleware(makeSocket(token)))?.message).toBe(
      'unauthorized',
    );
  });

  it('joins only branches where the user can view orders', async () => {
    const { runMiddleware, jwtService, gateway } = build({
      user: { id: 7, roles: ['Sale'], branchIds: [1, 2] },
      branchPerms: { 1: ['orders:view'], 2: ['invoices:view'] },
    });
    const socket = makeSocket(accessToken(jwtService));
    expect(await runMiddleware(socket)).toBeUndefined();
    await gateway.handleConnection(socket as any);

    expect([...socket.rooms].sort()).toEqual(
      ['sid', 'user:7', sessionRoom(3), ordersBranchRoom(1)].sort(),
    );
    gateway.handleDisconnect(socket as any);
  });

  it('Super Admin joins the all-orders room', async () => {
    const { runMiddleware, jwtService, gateway } = build({
      user: { id: 7, roles: ['Super Admin'], branchIds: [] },
    });
    const socket = makeSocket(accessToken(jwtService));
    await runMiddleware(socket);
    await gateway.handleConnection(socket as any);

    expect(socket.rooms.has(ORDERS_ALL_ROOM)).toBe(true);
    gateway.handleDisconnect(socket as any);
  });

  it('disconnects when the token expires', async () => {
    jest.useFakeTimers();
    const { runMiddleware, jwtService, gateway } = build({
      user: { id: 7, roles: [], branchIds: [] },
    });
    const token = jwtService.sign(claims, { expiresIn: '2s' });
    const socket = makeSocket(token);
    await runMiddleware(socket);
    await gateway.handleConnection(socket as any);

    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    gateway.handleDisconnect(socket as any);
  });
});
