import { BadRequestException } from '@nestjs/common';
import { MobileAuthController } from './mobile-auth.controller';
import type { Request, Response } from 'express';
import { LARK_NONCE_COOKIE } from '../auth-cookie.util';

const DEVICE = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 ký tự base64url
const APP_UA = 'HiSweetiePOS/1.0 (iPhone; iOS 18.1)';

const refresh = {
  sessionId: 1,
  token: 'raw-refresh-token',
  expiresAt: new Date('2026-11-07T00:00:00.000Z'),
};

type FakeReq = Request & { headers: Record<string, string> };

/** Request của app native: không Origin, không cookie. */
const makeReq = (headers: Record<string, string> = {}): FakeReq =>
  ({
    headers: { 'user-agent': APP_UA, 'x-device-id': DEVICE, ...headers },
    cookies: {},
    ip: '1.1.1.1',
  }) as unknown as FakeReq;
const makeRes = () => ({
  cookie: jest.fn<void, [string, string, unknown?]>(),
  clearCookie: jest.fn(),
  redirect: jest.fn(),
});

describe('MobileAuthController (iOS app)', () => {
  const setup = () => {
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
    };
    const larkAuthService = {
      buildMobileAuthorizeUrl: jest
        .fn()
        .mockReturnValue('https://accounts.larksuite.com/authorize?x=1'),
      exchangeMobileCode: jest.fn(),
      setupPassword: jest.fn().mockResolvedValue({
        accessToken: 'at3',
        expiresIn: 900,
        refresh,
        user: { id: 3 },
      }),
    };
    const sessionService = {
      revokeOwnSession: jest.fn().mockResolvedValue(true),
    };
    const controller = new MobileAuthController(
      authService as any,
      larkAuthService as any,
      sessionService as any,
    );
    return { controller, authService, larkAuthService, sessionService };
  };

  it('login works without Origin/cookies and returns the refresh token in the body', async () => {
    const { controller, authService } = setup();
    const body = await controller.login(
      { email: 'a@b.vn', password: 'pw' },
      makeReq(),
    );
    expect(authService.login).toHaveBeenCalledWith('a@b.vn', 'pw', undefined, {
      userAgent: APP_UA,
      ip: '1.1.1.1',
      deviceId: DEVICE,
    });
    expect(body).toEqual({
      accessToken: 'at',
      expiresIn: 900,
      user: { id: 1 },
      refreshToken: 'raw-refresh-token',
      refreshExpiresAt: '2026-11-07T00:00:00.000Z',
    });
    expect(body).not.toHaveProperty('refresh');
  });

  it.each([[{}], [{ 'x-device-id': 'short' }], [{ 'x-device-id': '' }]])(
    'login without a valid X-Device-Id is rejected before checking the password (%j)',
    async (headers) => {
      const { controller, authService } = setup();
      const req = makeReq();
      delete req.headers['x-device-id'];
      Object.assign(req.headers, headers);
      await expect(
        controller.login({ email: 'a', password: 'b' }, req),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(authService.login).not.toHaveBeenCalled();
    },
  );

  it('refresh asks for a reissue on the grace window and returns the new token', async () => {
    const { controller, authService } = setup();
    const body = await controller.refresh({ refreshToken: 'old' }, makeReq());
    expect(authService.refresh).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({ deviceId: DEVICE }),
      { reissueOnGrace: true },
    );
    expect(body).toEqual({
      accessToken: 'at2',
      expiresIn: 900,
      refreshToken: 'raw-refresh-token',
      refreshExpiresAt: '2026-11-07T00:00:00.000Z',
    });
  });

  it('refresh without a new token → app keeps the one it has', async () => {
    const { controller, authService } = setup();
    authService.refresh.mockResolvedValueOnce({
      accessToken: 'at2',
      expiresIn: 900,
      refresh: undefined,
    });
    const body = await controller.refresh({ refreshToken: 'x' }, makeReq());
    expect(body).toEqual({ accessToken: 'at2', expiresIn: 900 });
  });

  it('logout revokes the session of the presented token', async () => {
    const { controller, sessionService } = setup();
    await expect(controller.logout({ refreshToken: 'rt' })).resolves.toEqual({
      ok: true,
    });
    expect(sessionService.revokeOwnSession).toHaveBeenCalledWith(
      'rt',
      'logout',
    );
  });

  it('Lark start sets the browser nonce cookie and redirects to Lark', () => {
    const { controller, larkAuthService } = setup();
    const res = makeRes();
    controller.startLarkLogin(
      'hisweetiepos://auth/lark',
      'c'.repeat(43),
      'S256',
      res as unknown as Response,
    );
    const nonceCall = res.cookie.mock.calls.find(
      ([name]) => name === LARK_NONCE_COOKIE,
    );
    expect(nonceCall).toBeDefined();
    expect(larkAuthService.buildMobileAuthorizeUrl).toHaveBeenCalledWith(
      {
        redirectUri: 'hisweetiepos://auth/lark',
        codeChallenge: 'c'.repeat(43),
        codeChallengeMethod: 'S256',
      },
      nonceCall![1],
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://accounts.larksuite.com/authorize?x=1',
    );
  });

  it('Lark exchange checks the device id before spending the one-time code', async () => {
    const { controller, larkAuthService } = setup();
    const req = makeReq();
    delete req.headers['x-device-id'];
    await expect(
      controller.exchangeLarkCode({ code: 'c', codeVerifier: 'v' }, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(larkAuthService.exchangeMobileCode).not.toHaveBeenCalled();
  });

  it('Lark exchange returns tokens, or a setup token for first-time users', async () => {
    const { controller, larkAuthService } = setup();
    larkAuthService.exchangeMobileCode.mockResolvedValueOnce({
      session: { accessToken: 'at', expiresIn: 900, refresh, user: { id: 2 } },
    });
    await expect(
      controller.exchangeLarkCode({ code: 'c', codeVerifier: 'v' }, makeReq()),
    ).resolves.toMatchObject({
      accessToken: 'at',
      refreshToken: 'raw-refresh-token',
      user: { id: 2 },
    });

    larkAuthService.exchangeMobileCode.mockResolvedValueOnce({
      setupToken: 'setup-jwt',
    });
    await expect(
      controller.exchangeLarkCode({ code: 'c', codeVerifier: 'v' }, makeReq()),
    ).resolves.toEqual({ setupToken: 'setup-jwt' });
  });

  it('Lark setup-password returns tokens in the body', async () => {
    const { controller, larkAuthService } = setup();
    const input = {
      setupToken: 's',
      password: 'password-123',
      confirmPassword: 'password-123',
    };
    const body = await controller.setupLarkPassword(input, makeReq());
    expect(larkAuthService.setupPassword).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ deviceId: DEVICE, userAgent: APP_UA }),
    );
    expect(body).toMatchObject({
      accessToken: 'at3',
      refreshToken: 'raw-refresh-token',
    });
  });
});
