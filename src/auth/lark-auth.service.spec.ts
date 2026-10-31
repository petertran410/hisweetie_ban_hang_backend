import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { LarkAuthService } from './lark-auth.service';
import { exchangeCode } from './lark-oauth.util';

jest.mock('./lark-oauth.util', () => ({
  ...jest.requireActual('./lark-oauth.util'),
  exchangeCode: jest.fn(),
}));

const env: Record<string, string> = {
  JWT_SECRET: 'access-token-secret',
  LARK_APP_ID: 'cli_test',
  LARK_APP_SECRET: 'secret',
  LARK_OAUTH_REDIRECT_URI: 'https://api.example/api/auth/lark/callback',
  FRONTEND_URL: 'https://pos.example',
  MOBILE_REDIRECT_URIS:
    'hisweetiepos://auth/lark, exp://192.168.1.5:8081/--/auth/lark',
};

const setup = (user?: Record<string, unknown>) => {
  const jwt = new JwtService({
    secret: env.JWT_SECRET,
    signOptions: { algorithm: 'HS256' },
  });
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const authService = {
    issueAuthResponse: jest.fn().mockResolvedValue({
      accessToken: 'at',
      refresh: { sessionId: 1, token: 'rt', expiresAt: new Date() },
    }),
  };
  const service = new LarkAuthService(
    prisma as any,
    jwt,
    { get: (key: string) => env[key] } as any,
    authService as any,
    {} as any,
  );
  return { service, jwt, prisma, authService };
};

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('LarkAuthService — OAuth state bound to the browser', () => {
  beforeEach(() => (exchangeCode as jest.Mock).mockReset());

  it('callback without the matching browser cookie is rejected (login CSRF)', async () => {
    const { service } = setup();
    const state = stateOf(service.buildAuthorizeUrl('/', 'attacker-nonce'));

    for (const nonce of [undefined, 'victim-nonce']) {
      const { url, refresh } = await service.handleCallback(
        'code',
        state,
        {},
        nonce,
      );
      expect(url).toContain('lark_error=');
      expect(refresh).toBeUndefined();
    }
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('callback with the same browser cookie proceeds to Lark', async () => {
    const { service } = setup({
      id: 3,
      password: 'hash',
      googleId: null,
      isActive: true,
      larkUserId: 'ou_1',
    });
    (exchangeCode as jest.Mock).mockResolvedValue({
      user: { open_id: 'ou_1' },
    });
    const state = stateOf(service.buildAuthorizeUrl('/don-hang', 'n-123'));
    const { url, refresh } = await service.handleCallback(
      'code',
      state,
      {},
      'n-123',
    );
    expect(exchangeCode).toHaveBeenCalled();
    expect(url).toContain('lark_ok=1');
    expect(refresh).toBeDefined();
  });

  it('state is signed with its own key: never valid as an access token', () => {
    const { service, jwt } = setup();
    const state = stateOf(service.buildAuthorizeUrl('/', 'n'));
    expect(() => jwt.verify(state)).toThrow();
  });
});

describe('LarkAuthService.setupPassword — one-time token', () => {
  it('rejects a second use once the password is set', async () => {
    const { service, prisma } = setup({ id: 3, isActive: true });
    const token = (service as any).signSetupToken(3);
    const input = {
      setupToken: token,
      password: 'password-123',
      confirmPassword: 'password-123',
    };
    await expect(service.setupPassword(input)).resolves.toBeDefined();
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, password: null } }),
    );

    prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.setupPassword(input)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('LarkAuthService — iOS app login (PKCE + one-time code)', () => {
  beforeEach(() => (exchangeCode as jest.Mock).mockReset());

  const APP = 'hisweetiepos://auth/lark';
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  };
  const activeUser = {
    id: 3,
    password: 'hash',
    googleId: null,
    isActive: true,
    larkUserId: 'ou_1',
  };
  const ctx = { userAgent: 'HiSweetiePOS/1.0', deviceId: 'd'.repeat(22) };

  /** Chạy tới callback, trả URL backend chuyển về app. */
  const loginViaLark = async (
    svc: LarkAuthService,
    challenge: string,
    nonce = 'n-app',
  ) => {
    (exchangeCode as jest.Mock).mockResolvedValue({
      user: { open_id: 'ou_1' },
    });
    const state = stateOf(
      svc.buildMobileAuthorizeUrl(
        {
          redirectUri: APP,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
        },
        nonce,
      ),
    );
    return svc.handleCallback('lark-code', state, {}, nonce);
  };
  const codeOf = (url: string) => new URL(url).searchParams.get('code')!;

  it('rejects a redirect_uri that is not allow-listed, or a bad code_challenge', () => {
    const { service } = setup();
    const { challenge } = pkce();
    expect(() =>
      service.buildMobileAuthorizeUrl(
        { redirectUri: 'evilapp://steal', codeChallenge: challenge },
        'n',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      service.buildMobileAuthorizeUrl(
        { redirectUri: APP, codeChallenge: 'too-short' },
        'n',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      service.buildMobileAuthorizeUrl(
        {
          redirectUri: APP,
          codeChallenge: challenge,
          codeChallengeMethod: 'plain',
        },
        'n',
      ),
    ).toThrow(BadRequestException);
  });

  it('callback creates NO browser session and returns a one-time code to the app', async () => {
    const { service, authService } = setup(activeUser);
    const { challenge } = pkce();
    const { url, refresh } = await loginViaLark(service, challenge);
    expect(url.startsWith(APP + '?code=')).toBe(true);
    expect(refresh).toBeUndefined();
    expect(authService.issueAuthResponse).not.toHaveBeenCalled();
  });

  it('exchange with the right verifier creates the session with the app device info, once', async () => {
    const { service, authService } = setup(activeUser);
    const { verifier, challenge } = pkce();
    const code = codeOf((await loginViaLark(service, challenge)).url);

    const result = await service.exchangeMobileCode(code, verifier, ctx);
    expect(result).toHaveProperty('session');
    expect(authService.issueAuthResponse).toHaveBeenCalledWith(
      3,
      undefined,
      ctx,
    );

    await expect(
      service.exchangeMobileCode(code, verifier, ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.issueAuthResponse).toHaveBeenCalledTimes(1);
  });

  it('a stolen code is useless without the verifier, and does not burn the code', async () => {
    const { service } = setup(activeUser);
    const { verifier, challenge } = pkce();
    const code = codeOf((await loginViaLark(service, challenge)).url);

    await expect(
      service.exchangeMobileCode(code, pkce().verifier, ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.exchangeMobileCode(code, verifier, ctx),
    ).resolves.toHaveProperty('session');
  });

  it('first Lark login → exchange returns a setup token accepted by setupPassword', async () => {
    const { service, authService } = setup({ ...activeUser, password: null });
    const { verifier, challenge } = pkce();
    const code = codeOf((await loginViaLark(service, challenge)).url);

    const result = await service.exchangeMobileCode(code, verifier, ctx);
    expect(result).toHaveProperty('setupToken');
    expect(authService.issueAuthResponse).not.toHaveBeenCalled();

    await expect(
      service.setupPassword(
        {
          setupToken: (result as { setupToken: string }).setupToken,
          password: 'password-123',
          confirmPassword: 'password-123',
        },
        ctx,
      ),
    ).resolves.toBeDefined();
    expect(authService.issueAuthResponse).toHaveBeenCalledWith(
      3,
      undefined,
      ctx,
    );
  });

  it('a code is not accepted as a setup token or access token (separate keys)', async () => {
    const { service, jwt } = setup(activeUser);
    const { challenge } = pkce();
    const code = codeOf((await loginViaLark(service, challenge)).url);
    expect(() => jwt.verify(code)).toThrow();
    await expect(
      service.setupPassword({
        setupToken: code,
        password: 'password-123',
        confirmPassword: 'password-123',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('errors on an app login go back to the app, not the web login page', async () => {
    const { service } = setup(activeUser);
    const { challenge } = pkce();
    const state = stateOf(
      service.buildMobileAuthorizeUrl(
        { redirectUri: APP, codeChallenge: challenge },
        'right-nonce',
      ),
    );
    const { url } = await service.handleCallback('c', state, {}, 'wrong-nonce');
    expect(url.startsWith(APP + '?error=')).toBe(true);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('web login is unchanged: still redirects to the web login page', async () => {
    const { service } = setup(activeUser);
    (exchangeCode as jest.Mock).mockResolvedValue({
      user: { open_id: 'ou_1' },
    });
    const state = stateOf(service.buildAuthorizeUrl('/', 'n-web'));
    const { url, refresh } = await service.handleCallback(
      'c',
      state,
      {},
      'n-web',
    );
    expect(url).toBe('https://pos.example/login#lark_ok=1&return_to=%2F');
    expect(refresh).toBeDefined();
  });
});
