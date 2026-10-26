import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { DEVICE_COOKIE, REFRESH_COOKIE } from './auth-cookie.util';

const refresh = {
  sessionId: 1,
  token: 'raw-refresh-token',
  expiresAt: new Date(Date.now() + 7 * 86400_000),
};

const makeRes = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });
const makeReq = (over: Record<string, any> = {}) =>
  ({
    headers: { origin: 'http://localhost:3050', 'user-agent': 'jest' },
    cookies: {},
    ip: '1.1.1.1',
    ...over,
  }) as any;

describe('AuthController cookies', () => {
  const prevCors = process.env.CORS_ORIGIN;
  beforeAll(() => (process.env.CORS_ORIGIN = 'http://localhost:3050'));
  afterAll(() => (process.env.CORS_ORIGIN = prevCors));

  const authService = {
    login: jest.fn().mockResolvedValue({
      accessToken: 'at',
      expiresIn: 900,
      refresh,
      user: { id: 1 },
    }),
    refresh: jest.fn().mockResolvedValue({
      accessToken: 'at2',
      expiresIn: 900,
      refresh,
    }),
    decodeToken: jest.fn(),
  };
  const sessionService = {
    revokeByToken: jest.fn(),
    revokeSession: jest.fn(),
    revokeOtherSessions: jest.fn().mockResolvedValue(2),
  };
  const controller = new AuthController(
    authService as any,
    {} as any,
    sessionService as any,
  );

  it('login sets an HttpOnly/Secure/SameSite=Strict cookie scoped to /api/auth and never returns the refresh token', async () => {
    const res = makeRes();
    const body = await controller.login(
      { email: 'a', password: 'b' },
      makeReq(),
      res as any,
    );
    expect(body).toEqual({
      accessToken: 'at',
      expiresIn: 900,
      user: { id: 1 },
    });
    expect(JSON.stringify(body)).not.toContain('raw-refresh-token');
    const [, value, opts] = res.cookie.mock.calls.find(
      ([name]) => name === REFRESH_COOKIE,
    )!;
    expect(value).toBe('raw-refresh-token');
    expect(opts).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth',
    });
    expect(opts.domain).toBeUndefined();
  });

  it('login rejects a foreign or missing Origin (login CSRF)', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, {}]) {
      await expect(
        controller.login(
          { email: 'a', password: 'b' },
          makeReq({ headers }),
          makeRes() as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('refresh rejects a foreign Origin', async () => {
    await expect(
      controller.refresh(
        makeReq({ headers: { origin: 'https://evil.example' } }),
        makeRes() as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refresh rejects a missing Origin', async () => {
    await expect(
      controller.refresh(makeReq({ headers: {} }), makeRes() as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refresh failure clears the cookie', async () => {
    authService.refresh.mockRejectedValueOnce(new Error('401'));
    const res = makeRes();
    await expect(
      controller.refresh(
        makeReq({ cookies: { [REFRESH_COOKIE]: 'x' } }),
        res as any,
      ),
    ).rejects.toThrow();
    expect(res.clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({ path: '/api/auth' }),
    );
  });

  it('refresh rotates and returns only the access token', async () => {
    const res = makeRes();
    const body = await controller.refresh(
      makeReq({ cookies: { [REFRESH_COOKIE]: 'old' } }),
      res as any,
    );
    expect(authService.refresh).toHaveBeenCalledWith('old', expect.anything());
    expect(body).toEqual({ accessToken: 'at2', expiresIn: 900 });
    expect(res.cookie).toHaveBeenCalled();
  });

  it('logout revokes and clears cookie', async () => {
    const res = makeRes();
    await controller.logout(
      makeReq({ cookies: { [REFRESH_COOKIE]: 'tok' } }),
      res as any,
    );
    expect(sessionService.revokeByToken).toHaveBeenCalledWith('tok', 'logout');
    expect(res.clearCookie).toHaveBeenCalled();
  });

  it('login on a browser that already has a session replaces it (1 browser = 1 session)', async () => {
    authService.login.mockClear();
    await controller.login(
      { email: 'a', password: 'b' },
      makeReq({ cookies: { [REFRESH_COOKIE]: 'old-cookie' } }),
      makeRes() as any,
    );
    expect(authService.login).toHaveBeenCalledWith(
      'a',
      'b',
      undefined,
      expect.objectContaining({ replaceToken: 'old-cookie' }),
    );
  });

  it('login gives a browser without one a device id cookie (Lax, survives logout)', async () => {
    authService.login.mockClear();
    const res = makeRes();
    await controller.login(
      { email: 'a', password: 'b' },
      makeReq(),
      res as any,
    );
    const call = res.cookie.mock.calls.find(([name]) => name === DEVICE_COOKIE);
    expect(call).toBeDefined();
    const [, deviceId, opts] = call!;
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(opts).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/auth',
    });
    expect(authService.login.mock.calls[0][3].deviceId).toBe(deviceId);
  });

  it('keeps an existing device id and does not set it again', async () => {
    authService.login.mockClear();
    const res = makeRes();
    const deviceId = 'AbCdEfGhIjKlMnOpQrStUv';
    await controller.login(
      { email: 'a', password: 'b' },
      makeReq({ cookies: { [DEVICE_COOKIE]: deviceId } }),
      res as any,
    );
    expect(authService.login.mock.calls[0][3].deviceId).toBe(deviceId);
    expect(res.cookie.mock.calls.some(([name]) => name === DEVICE_COOKIE)).toBe(
      false,
    );
  });

  it('logout never clears the device id cookie', async () => {
    const res = makeRes();
    await controller.logout(
      makeReq({ cookies: { [REFRESH_COOKIE]: 'tok' } }),
      res as any,
    );
    expect(
      res.clearCookie.mock.calls.some(([name]) => name === DEVICE_COOKIE),
    ).toBe(false);
  });

  it('uses Cloudflare client IP for display', async () => {
    authService.login.mockClear();
    await controller.login(
      { email: 'a', password: 'b' },
      makeReq({
        headers: {
          origin: 'http://localhost:3050',
          'cf-connecting-ip': '113.1.2.3',
        },
      }),
      makeRes() as any,
    );
    expect(authService.login.mock.calls[0][3].ip).toBe('113.1.2.3');
  });

  it('device list marks the current device using the sid of the access token', async () => {
    const listDevices = jest.fn().mockResolvedValue([]);
    (authService as any).listDevices = listDevices;
    authService.decodeToken.mockReturnValueOnce({ sub: 1, sid: 42 });
    await controller.listMySessions(
      makeReq({
        headers: { authorization: 'Bearer t' },
        user: { id: 1 },
      }),
    );
    expect(listDevices).toHaveBeenCalledWith(1, 42);
  });

  it('cannot revoke a device that is not mine', async () => {
    sessionService.revokeSession.mockResolvedValueOnce(false);
    await expect(
      controller.revokeMySession(5, makeReq({ user: { id: 1 } })),
    ).rejects.toThrow('Không tìm thấy thiết bị');
    expect(sessionService.revokeSession).toHaveBeenCalledWith(1, 5);
  });

  it('revoke-others keeps the current device', async () => {
    authService.decodeToken.mockReturnValueOnce({ sub: 1, sid: 42 });
    const body = await controller.revokeOtherSessions(
      makeReq({ headers: { authorization: 'Bearer t' }, user: { id: 1 } }),
    );
    expect(sessionService.revokeOtherSessions).toHaveBeenCalledWith(1, 42);
    expect(body).toEqual({ ok: true, count: 2 });
  });
});
