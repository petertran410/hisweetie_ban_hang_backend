import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { REFRESH_COOKIE } from './auth-cookie.util';

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
    migrateLegacySession: jest.fn().mockResolvedValue({
      accessToken: 'at3',
      expiresIn: 900,
      refresh,
    }),
  };
  const sessionService = { revokeByToken: jest.fn() };
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
    const [name, value, opts] = res.cookie.mock.calls[0];
    expect(name).toBe(REFRESH_COOKIE);
    expect(value).toBe('raw-refresh-token');
    expect(opts).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth',
    });
    expect(opts.domain).toBeUndefined();
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

  it('migrate only accepts legacy tokens (without sid)', async () => {
    authService.decodeToken.mockReturnValueOnce({ sub: 1, sid: 5 });
    await expect(
      controller.migrateSession(
        makeReq({
          headers: {
            origin: 'http://localhost:3050',
            authorization: 'Bearer new',
          },
          user: { id: 1 },
        }),
        makeRes() as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    authService.decodeToken.mockReturnValueOnce({ sub: 1, pv: 1 });
    const res = makeRes();
    const body = await controller.migrateSession(
      makeReq({
        headers: {
          origin: 'http://localhost:3050',
          authorization: 'Bearer legacy',
        },
        user: { id: 1 },
      }),
      res as any,
    );
    expect(body).toEqual({ accessToken: 'at3', expiresIn: 900 });
    expect(res.cookie).toHaveBeenCalled();
  });
});
