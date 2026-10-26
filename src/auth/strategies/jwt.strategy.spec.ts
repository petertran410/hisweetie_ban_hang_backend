import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import {
  ACCESS_TOKEN_VERIFY_OPTIONS,
  JWT_ISSUER,
  LARK_TOKEN_AUDIENCE,
} from '../jwt-secret.util';

const SECRET = 'strategy-test-secret';

const setup = (sessionUsable = true) => {
  const cachedUser = { id: 7, roles: [], permissions: [] };
  const sessionService = {
    isSessionUsable: jest.fn().mockResolvedValue(sessionUsable),
  };
  const strategy = new JwtStrategy(
    { get: () => SECRET } as any,
    {} as any,
    { get: jest.fn(() => cachedUser) } as any,
    sessionService as any,
  );
  return { strategy, sessionService, cachedUser };
};

describe('JwtStrategy.validate — only current-format access tokens', () => {
  const valid = { sub: 7, typ: 'access', sid: 3, pv: 1 };

  it.each([
    ['legacy 7-day token (no typ/sid)', { sub: 7, pv: 1, email: 'a@b.c' }],
    ['missing sid', { sub: 7, typ: 'access', pv: 1 }],
    ['missing pv', { sub: 7, typ: 'access', sid: 3 }],
    ['other token type', { ...valid, typ: 'lark_setup' }],
    ['non-numeric sid', { ...valid, sid: '3' }],
  ])('rejects %s', async (_label, payload) => {
    const { strategy, sessionService } = setup();
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionService.isSessionUsable).not.toHaveBeenCalled();
  });

  it('accepts a full access token and checks its session', async () => {
    const { strategy, sessionService, cachedUser } = setup();
    await expect(strategy.validate(valid)).resolves.toBe(cachedUser);
    expect(sessionService.isSessionUsable).toHaveBeenCalledWith(3);
  });

  it('rejects when the session was revoked', async () => {
    const { strategy } = setup(false);
    await expect(strategy.validate(valid)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('Access token verify rules (iss / aud)', () => {
  const verifier = new JwtService({
    secret: SECRET,
    verifyOptions: ACCESS_TOKEN_VERIFY_OPTIONS,
  });

  it('a token issued by AuthService passes the shared verify rules', () => {
    const service = new AuthService(
      {} as any,
      new JwtService({ secret: SECRET }),
      {} as any,
      {} as any,
    );
    const { accessToken } = service.signAccessToken(7, 1, 3);
    expect(verifier.verify(accessToken)).toMatchObject({
      sub: 7,
      sid: 3,
      iss: JWT_ISSUER,
    });
  });

  it('a token without iss/aud is rejected', () => {
    const bare = new JwtService({ secret: SECRET }).sign({
      sub: 7,
      typ: 'access',
      sid: 3,
      pv: 1,
    });
    expect(() => verifier.verify(bare)).toThrow(/audience|issuer/);
  });

  it('a Lark token (other audience) is rejected even with the same key', () => {
    const lark = new JwtService({ secret: SECRET }).sign(
      { typ: 'lark_setup', uid: 7 },
      { issuer: JWT_ISSUER, audience: LARK_TOKEN_AUDIENCE },
    );
    expect(() => verifier.verify(lark)).toThrow(/audience/);
  });
});
