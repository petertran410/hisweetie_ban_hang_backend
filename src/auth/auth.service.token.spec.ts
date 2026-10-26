import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService access token payload', () => {
  it('contains only sub, pv, typ (+ iat/exp) — no personal data', async () => {
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
    const service = new AuthService(prisma as any, jwt, {} as any);

    const res = await service.issueAuthResponse(5);
    const payload = jwt.decode<Record<string, unknown>>(res.accessToken);

    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'iat', 'pv', 'sub', 'typ'].sort(),
    );
    expect(payload).toMatchObject({ sub: 5, pv: 3, typ: 'access' });
    // Thông tin hiển thị vẫn có trong response, chỉ không nằm trong token.
    expect(res.user.email).toBe('staff@example.com');
  });
});
