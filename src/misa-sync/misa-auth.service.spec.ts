import { of } from 'rxjs';
import { MisaAuthService } from './misa-auth.service';

describe('MisaAuthService OpenAPI token flow', () => {
  it('requests the new token endpoint with ClientID and caches the token expiry', async () => {
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          Success: true,
          Data: {
            access_token: 'access-token',
            expired_time: new Date(
              Date.now() + 2 * 60 * 60 * 1000,
            ).toISOString(),
          },
        },
      }),
    );
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          MISA_BASE_URL: 'https://developer.misa.vn/apis/',
          MISA_CLIENT_ID: 'client-id',
          MISA_ACCESS_CODE: 'access-code',
          MISA_ORG_COMPANY_CODE: 'company-code',
        };
        return values[key];
      }),
    };

    const service = new MisaAuthService(config as any, { post } as any);

    await expect(service.getAccessToken()).resolves.toBe('access-token');
    await expect(service.getAccessToken()).resolves.toBe('access-token');

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://developer.misa.vn/apis/amiskt/v1/token',
      {
        access_code: 'access-code',
        org_company_code: 'company-code',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ClientID: 'client-id',
        },
      },
    );
  });
});
