import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService access token payload', () => {
  it('contains only sub, pv, typ, sid (+ iat/exp) — no personal data', async () => {
    const jwt = new JwtService({
      secret: 'test',
      signOptions: { expiresIn: '7d' },
    });
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 5,
          email: 'staff@example.com',
          name: 'Nhân viên',
          phone: '0900000000',
          isActive: true,
          permissionVersion: 3,
          branchId: null,
          userRoles: [],
          userPermissions: [],
        }),
      },
      userBranch: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const sessionService = {
      createSession: jest.fn().mockResolvedValue({
        sessionId: 11,
        token: 'raw-refresh',
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      }),
    };
    const service = new AuthService(
      prisma as any,
      jwt,
      {} as any,
      sessionService as any,
    );

    const res = await service.issueAuthResponse(5);
    const payload = jwt.decode<Record<string, unknown>>(res.accessToken);

    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'iat', 'pv', 'sid', 'sub', 'typ'].sort(),
    );
    expect(payload).toMatchObject({ sub: 5, pv: 3, typ: 'access', sid: 11 });
    // Access token ngắn hạn (15 phút mặc định).
    expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);
    expect(res.expiresIn).toBe(15 * 60);
    // Refresh token không nằm trong body/token — controller đặt vào cookie.
    expect(res.refresh.token).toBe('raw-refresh');
    // Thông tin hiển thị vẫn có trong response, chỉ không nằm trong token.
    expect(res.user.email).toBe('staff@example.com');
  });
});
