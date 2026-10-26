import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserThrottlerGuard } from './user-throttler.guard';
import { ACCESS_TOKEN_AUDIENCE, JWT_ISSUER } from '../../auth/jwt-secret.util';

const SECRET = 'throttler-test-secret';

describe('UserThrottlerGuard tracker', () => {
  const prev = process.env.JWT_SECRET;
  beforeAll(() => (process.env.JWT_SECRET = SECRET));
  afterAll(() => (process.env.JWT_SECRET = prev));

  const guard = new UserThrottlerGuard(
    { throttlers: [] } as any,
    {} as any,
    new Reflector(),
  );
  const tracker = (authorization?: string) =>
    (guard as any).getTracker({
      ip: '1.2.3.4',
      headers: authorization ? { authorization } : {},
    }) as Promise<string>;

  it('counts by user for a validly signed token', async () => {
    const token = new JwtService({ secret: SECRET }).sign(
      { sub: 42 },
      { issuer: JWT_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
    );
    expect(await tracker(`Bearer ${token}`)).toBe('user:42');
  });

  it('falls back to IP for a token of another audience (vd token Lark)', async () => {
    const token = new JwtService({ secret: SECRET }).sign(
      { sub: 42 },
      { issuer: JWT_ISSUER, audience: 'hisweetie-lark-oauth' },
    );
    expect(await tracker(`Bearer ${token}`)).toBe('ip:1.2.3.4');
  });

  it('falls back to IP for a forged token (cannot mint fresh buckets)', async () => {
    const forged = new JwtService({ secret: 'attacker' }).sign({ sub: 999 });
    expect(await tracker(`Bearer ${forged}`)).toBe('ip:1.2.3.4');
  });

  it('falls back to IP for an unsigned (alg none) token', async () => {
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 7 })}.`;
    expect(await tracker(`Bearer ${none}`)).toBe('ip:1.2.3.4');
  });

  it('falls back to IP without a token', async () => {
    expect(await tracker()).toBe('ip:1.2.3.4');
  });
});
