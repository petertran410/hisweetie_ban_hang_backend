import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
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
