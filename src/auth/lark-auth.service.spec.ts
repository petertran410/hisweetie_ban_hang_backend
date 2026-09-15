import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { LarkAuthService } from './lark-auth.service';
import { exchangeCode } from './lark-oauth.util';

jest.mock('./lark-oauth.util', () => {
  const actual = jest.requireActual('./lark-oauth.util');
  return {
    ...actual,
    exchangeCode: jest.fn(),
  };
});

jest.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: jest.fn().mockImplementation(() => ({
    register: jest.fn().mockReturnThis(),
    invoke: jest.fn().mockResolvedValue(undefined),
  })),
  generateChallenge: jest.fn().mockReturnValue({
    isChallenge: false,
    challenge: { challenge: 'x' },
  }),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

const exchangeCodeMock = exchangeCode as jest.MockedFunction<typeof exchangeCode>;

describe('LarkAuthService', () => {
  let service: LarkAuthService;
  let prisma: any;
  let jwt: any;
  let config: any;
  let authService: any;

  const profile = {
    open_id: 'ou_new',
    name: 'An Nguyen',
    email: 'an@gmail.com',
    enterprise_email: 'an@hisweetie.com',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    jwt = {
      sign: jest.fn((payload: any) => {
        if (payload.typ === 'lark_oauth_state') return 'state-jwt';
        if (payload.typ === 'lark_setup') return 'setup-jwt';
        return 'access-jwt';
      }),
      verify: jest.fn(),
    };
    config = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          LARK_APP_ID: 'cli_test',
          LARK_APP_SECRET: 'secret_test',
          LARK_OAUTH_REDIRECT_URI:
            'http://localhost:3060/api/auth/lark/callback',
          FRONTEND_URL: 'http://localhost:3050',
          LARK_ENCRYPT_KEY: 'enc',
          LARK_VERIFICATION_TOKEN: 'verify',
        };
        return map[key];
      }),
    };
    authService = {
      issueAuthResponse: jest.fn().mockResolvedValue({
        accessToken: 'access-jwt',
        user: { id: 1, email: 'an@hisweetie.com' },
      }),
    };
    service = new LarkAuthService(prisma, jwt, config, authService);
    exchangeCodeMock.mockReset();
  });

  describe('provisionFromContactCreated', () => {
    it('creates an inactive user with enterprise email and no role', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValue({ id: 9 });

      const result = await service.provisionFromContactCreated({
        open_id: 'ou_new',
        name: 'An Nguyen',
        email: 'an@gmail.com',
        enterprise_email: 'an@hisweetie.com',
      });

      expect(result).toBe('created');
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'An Nguyen',
          email: 'an@hisweetie.com',
          larkUserId: 'ou_new',
          isActive: false,
        }),
      });
      expect(prisma.user.create.mock.calls[0][0].data.userRoles).toBeUndefined();
    });

    it('uses the only available email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 9 });

      await service.provisionFromContactCreated({
        open_id: 'ou_new',
        name: 'An',
        email: 'an@gmail.com',
      });
      expect(prisma.user.create.mock.calls[0][0].data.email).toBe(
        'an@gmail.com',
      );
    });

    it('skips when there is no email', async () => {
      const result = await service.provisionFromContactCreated({
        open_id: 'ou_new',
        name: 'An',
      });
      expect(result).toBe('skipped');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('skips when email already belongs to another POS user', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 2 });
      const result = await service.provisionFromContactCreated({
        open_id: 'ou_new',
        email: 'old@hisweetie.com',
      });
      expect(result).toBe('skipped');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('skips when larkUserId already exists', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 3 });
      const result = await service.provisionFromContactCreated({
        open_id: 'ou_new',
        enterprise_email: 'an@hisweetie.com',
      });
      expect(result).toBe('skipped');
    });
  });

  describe('completeLarkLogin', () => {
    it('activates an onboarding shell and returns a setup token', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: null,
        googleId: null,
        isActive: false,
        larkUserId: 'ou_new',
      });
      prisma.user.update.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: null,
        googleId: null,
        isActive: true,
        larkUserId: 'ou_new',
      });

      const result = await service.completeLarkLogin(profile);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 11 },
          data: { isActive: true },
        }),
      );
      expect(result).toEqual({ mode: 'setup', token: 'setup-jwt' });
    });

    it('issues a POS session when the user already has a password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: 'hashed',
        googleId: null,
        isActive: true,
        larkUserId: 'ou_new',
      });

      const result = await service.completeLarkLogin(profile);
      expect(authService.issueAuthResponse).toHaveBeenCalledWith(11);
      expect(result).toEqual({ mode: 'session', token: 'access-jwt' });
    });

    it('asks for a password when the active user has none', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: null,
        googleId: 'g1',
        isActive: true,
        larkUserId: 'ou_new',
      });
      const result = await service.completeLarkLogin(profile);
      expect(result.mode).toBe('setup');
    });

    it('rejects an admin-locked account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: 'hashed',
        googleId: null,
        isActive: false,
        larkUserId: 'ou_new',
      });
      await expect(service.completeLarkLogin(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an admin-locked Google account without password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        email: 'an@hisweetie.com',
        name: 'An',
        password: null,
        googleId: 'g1',
        isActive: false,
        larkUserId: 'ou_new',
      });
      await expect(service.completeLarkLogin(profile)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('creates an active user on QR fallback when webhook missed', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValue({
        id: 12,
        email: 'an@hisweetie.com',
        name: 'An Nguyen',
        password: null,
        googleId: null,
        isActive: true,
        larkUserId: 'ou_new',
      });

      const result = await service.completeLarkLogin(profile);
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'an@hisweetie.com',
            larkUserId: 'ou_new',
            isActive: true,
          }),
        }),
      );
      expect(result).toEqual({ mode: 'setup', token: 'setup-jwt' });
    });

    it('does not auto-link when QR email already exists', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 99 });
      await expect(service.completeLarkLogin(profile)).rejects.toThrow(
        /gắn Lark ID/,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('setupPassword', () => {
    it('rejects mismatched or short passwords', async () => {
      jwt.verify.mockReturnValue({ typ: 'lark_setup', uid: 11 });
      await expect(
        service.setupPassword({
          setupToken: 'setup-jwt',
          password: 'secret12',
          confirmPassword: 'secret99',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.setupPassword({
          setupToken: 'setup-jwt',
          password: 'short',
          confirmPassword: 'short',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hashes the password and issues a POS session', async () => {
      jwt.verify.mockReturnValue({ typ: 'lark_setup', uid: 11 });
      prisma.user.findUnique.mockResolvedValue({ id: 11, isActive: true });
      prisma.user.update.mockResolvedValue({ id: 11 });

      const result = await service.setupPassword({
        setupToken: 'setup-jwt',
        password: 'secret123',
        confirmPassword: 'secret123',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: { password: 'hashed-password' },
      });
      expect(authService.issueAuthResponse).toHaveBeenCalledWith(11);
      expect(result.accessToken).toBe('access-jwt');
    });
  });

  describe('handleCallback', () => {
    it('redirects to the setup hash after a first QR login', async () => {
      jwt.verify.mockReturnValue({ typ: 'lark_oauth_state', returnTo: '/' });
      exchangeCodeMock.mockResolvedValue({ user: profile });
      jest.spyOn(service, 'completeLarkLogin').mockResolvedValue({
        mode: 'setup',
        token: 'setup-jwt',
      });

      const url = await service.handleCallback('code', 'state-jwt');
      expect(url).toContain('http://localhost:3050/login#');
      expect(url).toContain('lark_setup=setup-jwt');
    });

    it('redirects to the POS token hash when the user already has a password', async () => {
      jwt.verify.mockReturnValue({ typ: 'lark_oauth_state', returnTo: '/orders' });
      exchangeCodeMock.mockResolvedValue({ user: profile });
      jest.spyOn(service, 'completeLarkLogin').mockResolvedValue({
        mode: 'session',
        token: 'access-jwt',
      });

      const url = await service.handleCallback('code', 'state-jwt');
      expect(url).toContain('lark_token=access-jwt');
      expect(url).toContain('return_to=%2Forders');
      expect(url).not.toContain('lark_setup=');
    });
  });

  describe('handleEvent', () => {
    it('returns the URL verification challenge', async () => {
      const lark = jest.requireMock('@larksuiteoapi/node-sdk');
      lark.generateChallenge.mockReturnValueOnce({
        isChallenge: true,
        challenge: { challenge: 'abc' },
      });
      await expect(
        service.handleEvent({ type: 'url_verification', challenge: 'abc' }),
      ).resolves.toEqual({ challenge: 'abc' });
    });
  });
});
