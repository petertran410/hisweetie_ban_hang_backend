import { HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService, INVALID_LOGIN_MESSAGE } from './auth.service';
import { LoginAttemptsService } from './login-attempts.service';

describe('LoginAttemptsService', () => {
  const t0 = 1_000_000;

  it('locks an email+IP pair after 5 failures for 15 minutes', () => {
    const attempts = new LoginAttemptsService();
    for (let i = 0; i < 4; i++) {
      expect(attempts.recordFailure('A@x.vn', '1.1.1.1', t0).lockedNow).toBe(
        false,
      );
    }
    expect(attempts.recordFailure('a@x.vn', '1.1.1.1', t0).lockedNow).toBe(
      true,
    );
    expect(() => attempts.assertNotLocked('a@x.vn', '1.1.1.1', t0)).toThrow(
      HttpException,
    );
    // IP khác vẫn đăng nhập được (kẻ xấu không khoá được người thật).
    expect(() =>
      attempts.assertNotLocked('a@x.vn', '2.2.2.2', t0),
    ).not.toThrow();
    // Hết 15 phút → mở khoá.
    expect(() =>
      attempts.assertNotLocked('a@x.vn', '1.1.1.1', t0 + 15 * 60_000 + 1),
    ).not.toThrow();
  });

  it('caps one account across many IPs (distributed guessing)', () => {
    const attempts = new LoginAttemptsService();
    for (let i = 0; i < 20; i++) {
      attempts.recordFailure('boss@x.vn', `10.0.0.${i}`, t0);
    }
    expect(() => attempts.assertNotLocked('boss@x.vn', '10.9.9.9', t0)).toThrow(
      HttpException,
    );
  });

  it('a successful login clears the counter for that IP', () => {
    const attempts = new LoginAttemptsService();
    for (let i = 0; i < 4; i++) attempts.recordFailure('a@x.vn', '1.1.1.1', t0);
    attempts.recordSuccess('a@x.vn', '1.1.1.1');
    expect(attempts.recordFailure('a@x.vn', '1.1.1.1', t0).lockedNow).toBe(
      false,
    );
  });
});

describe('AuthService.login hardening', () => {
  const setup = async (
    user: { id: number; password: string | null; isActive: boolean } | null,
  ) => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    const attempts = new LoginAttemptsService();
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      attempts,
    );
    const issue = jest
      .spyOn(service, 'issueAuthResponse')
      .mockResolvedValue({ accessToken: 'at' } as any);
    return { service, attempts, issue };
  };

  it('unknown email, Lark-only account and wrong password give the SAME message', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    const cases = [
      await setup(null),
      await setup({ id: 1, password: null, isActive: true }),
      await setup({ id: 1, password: hash, isActive: true }),
    ];
    for (const { service } of cases) {
      await expect(
        service.login('a@x.vn', 'wrong', undefined, { ip: '1.1.1.1' }),
      ).rejects.toThrow(new UnauthorizedException(INVALID_LOGIN_MESSAGE));
    }
  });

  it('still runs bcrypt when the email does not exist (no timing leak)', async () => {
    const { service } = await setup(null);
    const compare = jest.spyOn(bcrypt, 'compare');
    await expect(service.login('ghost@x.vn', 'pw')).rejects.toBeDefined();
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('5 wrong passwords lock the account even if the 6th is right', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    const { service, issue } = await setup({
      id: 1,
      password: hash,
      isActive: true,
    });
    const ctx = { ip: '1.1.1.1' };
    for (let i = 0; i < 5; i++) {
      await expect(
        service.login('a@x.vn', 'wrong', undefined, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.login('a@x.vn', 'right-password', undefined, ctx),
    ).rejects.toMatchObject({ status: 429 });
    expect(issue).not.toHaveBeenCalled();
  });

  it('records failed / locked / successful logins in the security log', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, password: hash, isActive: true }),
      },
    };
    const audit = { record: jest.fn() };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      new LoginAttemptsService(),
      audit as any,
    );
    jest
      .spyOn(service, 'issueAuthResponse')
      .mockResolvedValue({ accessToken: 'at' } as any);
    const ctx = { ip: '9.9.9.9', userAgent: 'ua' };

    await service.login('a@x.vn', 'right-password', undefined, ctx);
    expect(audit.record).toHaveBeenLastCalledWith(
      'AUTH_LOGIN_SUCCESS',
      expect.objectContaining({ userId: 1, ip: '9.9.9.9' }),
    );
    for (let i = 0; i < 5; i++) {
      await service.login('a@x.vn', 'wrong', undefined, ctx).catch(() => {});
    }
    const codes = audit.record.mock.calls.map(([code]) => code);
    expect(codes.filter((c) => c === 'AUTH_LOGIN_FAILED')).toHaveLength(5);
    expect(codes).toContain('AUTH_LOGIN_LOCKED');
  });

  it('inactive account is only revealed after the right password', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    const { service } = await setup({ id: 1, password: hash, isActive: false });
    await expect(service.login('a@x.vn', 'wrong')).rejects.toThrow(
      INVALID_LOGIN_MESSAGE,
    );
    await expect(service.login('a@x.vn', 'right-password')).rejects.toThrow(
      'Tài khoản đã bị vô hiệu hóa',
    );
  });
});

describe('AuthService.getPermissionsForBranch — branch from the client', () => {
  const perm = (resource: string, action: string) => ({
    permission: { resource, action },
  });
  /** Role "Kho" có quyền chung invoices:view; riêng chi nhánh 2: + invoices:delete. */
  const role = {
    rolePermissions: [perm('invoices', 'view')],
    roleBranchPermissions: [
      perm('invoices', 'view'),
      perm('invoices', 'delete'),
    ],
  };
  const make = (membership: {
    branchId?: number;
    userBranches?: unknown[];
  }) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9,
          branchId: membership.branchId ?? 1,
          userBranches: membership.userBranches ?? [],
          userBranchRoles: [],
          userRoles: [{ role }],
          userPermissions: [],
        }),
      },
      userBranchPermission: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new AuthService(prisma as any, {} as any, {} as any, {} as any);
  };

  it('a user NOT attached to branch 2 cannot pick up its branch-only permissions', async () => {
    const permissions = await make({ branchId: 1 }).getPermissionsForBranch(
      9,
      2,
    );
    expect(permissions).toEqual(['invoices:view']);
  });

  it('a member of branch 2 gets them', async () => {
    const permissions = await make({
      branchId: 1,
      userBranches: [{ branchId: 2 }],
    }).getPermissionsForBranch(9, 2);
    expect(permissions.sort()).toEqual(['invoices:delete', 'invoices:view']);
  });
});
