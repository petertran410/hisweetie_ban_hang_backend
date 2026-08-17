import { UnauthorizedException } from '@nestjs/common';
import { PublicApiAuthService } from './public-api-auth.service';
import * as bcrypt from 'bcrypt';

describe('PublicApiAuthService', () => {
  const originalPublicSecret = process.env.PUBLIC_API_JWT_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  const createService = (client: any = null) => {
    const prisma = { publicApiClient: { findUnique: jest.fn().mockResolvedValue(client) } };
    const jwtService = { signAsync: jest.fn().mockResolvedValue('access-token') };
    return {
      prisma,
      jwtService,
      service: new PublicApiAuthService(prisma as any, jwtService as any),
    };
  };

  beforeEach(() => {
    process.env.PUBLIC_API_JWT_SECRET = 'public-api-test-secret';
    process.env.JWT_SECRET = 'internal-test-secret';
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalPublicSecret === undefined) delete process.env.PUBLIC_API_JWT_SECRET;
    else process.env.PUBLIC_API_JWT_SECRET = originalPublicSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('rejects unsupported grant types before accessing storage', async () => {
    const { service, prisma, jwtService } = createService();

    try {
      await service.issueToken({ grantType: 'authorization_code' });
      fail('Expected unsupported grant type to throw');
    } catch (error: any) {
      expect(error.getResponse()).toEqual(expect.objectContaining({ error: 'unsupported_grant_type' }));
    }

    expect(prisma.publicApiClient.findUnique).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects missing client credentials before accessing storage', async () => {
    const { service, prisma } = createService();

    await expect(service.issueToken({ grantType: 'client_credentials' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.publicApiClient.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown client', null, undefined],
    ['inactive client', { id: 'client-id', clientId: 'partner', clientSecret: 'hash', isActive: false, accessTokenTtl: 3600 }, undefined],
    ['wrong secret', { id: 'client-id', clientId: 'partner', clientSecret: 'hash', isActive: true, accessTokenTtl: 3600 }, false],
  ])('rejects %s', async (_name, client, bcryptResult) => {
    const { service, jwtService } = createService(client);
    const compare = jest.spyOn(bcrypt, 'compare');
    if (bcryptResult !== undefined) compare.mockResolvedValue(bcryptResult as never);

    await expect(service.issueToken({
      grantType: 'client_credentials', clientId: 'partner', clientSecret: 'wrong',
    })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('issues a typed token with client credentials and requested scope', async () => {
    const client = {
      id: 'client-uuid', clientId: 'zalo-crm', clientSecret: 'hash', isActive: true, accessTokenTtl: 3600,
    };
    const { service, prisma, jwtService } = createService(client);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

    await expect(service.issueToken({
      grantType: 'client_credentials', clientId: 'zalo-crm', clientSecret: 'secret', scope: 'customers.read invoices.read',
    })).resolves.toEqual({
      access_token: 'access-token', token_type: 'Bearer', expires_in: 3600, scope: 'customers.read invoices.read',
    });

    expect(prisma.publicApiClient.findUnique).toHaveBeenCalledWith({ where: { clientId: 'zalo-crm' } });
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: 'client-uuid', clientId: 'zalo-crm', typ: 'public_api' },
      { secret: 'public-api-test-secret', expiresIn: 3600 },
    );
  });

  it.each([
    [1, 300],
    [999999, 86400],
  ])('clamps a client token TTL of %i seconds to %i seconds', async (storedTtl, expectedTtl) => {
    const client = { id: 'client-id', clientId: 'partner', clientSecret: 'hash', isActive: true, accessTokenTtl: storedTtl };
    const { service, jwtService } = createService(client);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

    await service.issueToken({ grantType: 'client_credentials', clientId: 'partner', clientSecret: 'secret' });

    expect(jwtService.signAsync).toHaveBeenLastCalledWith(expect.any(Object), {
      secret: 'public-api-test-secret', expiresIn: expectedTtl,
    });
  });
});
