import { UnauthorizedException } from '@nestjs/common';
import { PublicApiAuthGuard } from './public-api-auth.guard';

describe('PublicApiAuthGuard', () => {
  const originalPublicSecret = process.env.PUBLIC_API_JWT_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  const createGuard = (client: unknown = { id: 'client-uuid', isActive: true }) => {
    const jwtService = { verifyAsync: jest.fn() };
    const prisma = {
      publicApiClient: { findUnique: jest.fn().mockResolvedValue(client) },
    };
    const guard = new PublicApiAuthGuard(jwtService as any, prisma as any);
    const request: Record<string, any> = { headers: {} };
    const context = {
      getHandler: () => 'handler',
      getClass: () => 'controller',
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
    return { guard, jwtService, prisma, request, context };
  };

  beforeEach(() => {
    process.env.PUBLIC_API_JWT_SECRET = 'public-api-test-secret';
    process.env.JWT_SECRET = 'internal-test-secret';
  });

  afterAll(() => {
    if (originalPublicSecret === undefined) delete process.env.PUBLIC_API_JWT_SECRET;
    else process.env.PUBLIC_API_JWT_SECRET = originalPublicSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it.each([undefined, 'Basic abc', 'bearer abc'])('rejects invalid authorization header %p', async (authorization) => {
    const { guard, request, context } = createGuard();
    request.headers.authorization = authorization;
    await expect(guard.canActivate(context)).rejects.toEqual(
      expect.objectContaining({ message: 'Missing public API bearer token' }),
    );
  });

  it('rejects inactive clients even when their JWT is not expired', async () => {
    const { guard, jwtService, request, context } = createGuard({ id: 'client-uuid', isActive: false });
    request.headers.authorization = 'Bearer token';
    jwtService.verifyAsync.mockResolvedValue({ sub: 'client-uuid', clientId: 'zalo-crm', typ: 'public_api' });

    await expect(guard.canActivate(context)).rejects.toEqual(
      expect.objectContaining({ message: 'Public API client is inactive' }),
    );
  });
  it('verifies a public API token and attaches client identity to the request', async () => {
    const { guard, jwtService, request, context } = createGuard();
    request.headers.authorization = 'Bearer token-with-whitespace  ';
    jwtService.verifyAsync.mockResolvedValue({ sub: 'client-uuid', clientId: 'zalo-crm', typ: 'public_api' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('token-with-whitespace', {
      secret: 'public-api-test-secret',
    });
    expect(request.publicApiClient).toEqual({ id: 'client-uuid', clientId: 'zalo-crm' });
  });

  it.each([
    { sub: 'client-uuid', clientId: 'zalo-crm', typ: 'internal' },
    { clientId: 'zalo-crm', typ: 'public_api' },
    { sub: 'client-uuid', typ: 'public_api' },
  ])('rejects payloads that are not a complete public token: %p', async (payload) => {
    const { guard, jwtService, request, context } = createGuard();
    request.headers.authorization = 'Bearer token';
    jwtService.verifyAsync.mockResolvedValue(payload);

    await expect(guard.canActivate(context)).rejects.toEqual(
      expect.objectContaining({ message: 'Invalid public API bearer token' }),
    );
    expect(request.publicApiClient).toBeUndefined();
  });

  it('normalizes JWT verification errors without leaking internals', async () => {
    const { guard, jwtService, request, context } = createGuard();
    request.headers.authorization = 'Bearer expired-token';
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(guard.canActivate(context)).rejects.toEqual(
      expect.objectContaining({ message: 'Invalid or expired public API bearer token' }),
    );
  });

  it('normalizes JWT invalid-token exceptions without leaking internals', async () => {
    const { guard, jwtService, request, context } = createGuard();
    request.headers.authorization = 'Bearer malformed-public-token';
    jwtService.verifyAsync.mockRejectedValue(new UnauthorizedException('Invalid public API bearer token'));

    await expect(guard.canActivate(context)).rejects.toEqual(
      expect.objectContaining({ message: 'Invalid or expired public API bearer token' }),
    );
  });
});
