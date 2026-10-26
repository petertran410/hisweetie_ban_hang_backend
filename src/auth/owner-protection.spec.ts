import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertCanAssignRoles,
  assertCanEditRole,
  assertCanManageUser,
  assertNotLastSuperAdmin,
  assertRoleNameAllowed,
  assertUserUpdateAllowed,
} from './owner-protection';

const OWNER_ROLE_ID = 1;
const ADMIN_ROLE_ID = 2;

/** userId → { roleIds, isActive } */
function fakeDb(
  users: Record<number, { roleIds: number[]; isActive?: boolean }>,
) {
  const ownerRows = () =>
    Object.entries(users)
      .filter(([, u]) => u.roleIds.includes(OWNER_ROLE_ID))
      .map(([id, u]) => ({ userId: Number(id), isActive: u.isActive ?? true }));
  return {
    role: {
      findUnique: jest.fn(() => Promise.resolve({ id: OWNER_ROLE_ID })),
    },
    userRole: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          ownerRows().find((r) => r.userId === where.userId) ?? null,
        ),
      ),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          ownerRows().filter((r) => r.userId !== where.userId.not && r.isActive)
            .length,
        ),
      ),
    },
  } as any;
}

const owner = { id: 1, roles: ['Super Admin'] };
const admin = { id: 2, roles: ['Admin'] };

describe('owner protection', () => {
  const db = fakeDb({
    1: { roleIds: [OWNER_ROLE_ID] },
    2: { roleIds: [ADMIN_ROLE_ID] },
    3: { roleIds: [] },
  });

  it('a normal admin cannot touch a Super Admin account', async () => {
    await expect(assertCanManageUser(db, admin, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(assertCanManageUser(db, admin, 3)).resolves.toBeUndefined();
    await expect(assertCanManageUser(db, owner, 1)).resolves.toBeUndefined();
  });

  it('only a Super Admin can hand out the Super Admin role', async () => {
    await expect(
      assertCanAssignRoles(db, admin, [ADMIN_ROLE_ID, OWNER_ROLE_ID]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      assertCanAssignRoles(db, admin, [ADMIN_ROLE_ID]),
    ).resolves.toBeUndefined();
    await expect(
      assertCanAssignRoles(db, owner, [OWNER_ROLE_ID]),
    ).resolves.toBeUndefined();
  });

  it('PUT /users/:id by a normal admin: cannot change a Super Admin password/email', async () => {
    await expect(
      assertUserUpdateAllowed(db, admin, 1, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the last Super Admin cannot be demoted, deactivated or deleted', async () => {
    await expect(
      assertUserUpdateAllowed(db, owner, 1, { roleIds: [ADMIN_ROLE_ID] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertUserUpdateAllowed(db, owner, 1, { isActive: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertNotLastSuperAdmin(db, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Không phải Super Admin → không bị chặn.
    await expect(assertNotLastSuperAdmin(db, 3)).resolves.toBeUndefined();
  });

  it('with a second active Super Admin, demoting one is allowed', async () => {
    const two = fakeDb({
      1: { roleIds: [OWNER_ROLE_ID] },
      4: { roleIds: [OWNER_ROLE_ID] },
    });
    await expect(
      assertUserUpdateAllowed(two, owner, 1, { roleIds: [ADMIN_ROLE_ID] }),
    ).resolves.toBeUndefined();
  });

  it('a deactivated second Super Admin does not count', async () => {
    const two = fakeDb({
      1: { roleIds: [OWNER_ROLE_ID] },
      4: { roleIds: [OWNER_ROLE_ID], isActive: false },
    });
    await expect(assertNotLastSuperAdmin(two, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('the Super Admin role name is reserved and immutable', () => {
    expect(() => assertRoleNameAllowed(null, 'Super Admin')).toThrow(
      BadRequestException,
    );
    expect(() => assertRoleNameAllowed('Kho', '  super admin ')).toThrow(
      BadRequestException,
    );
    expect(() => assertRoleNameAllowed('Super Admin', 'Owner')).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertRoleNameAllowed('Super Admin', 'Super Admin'),
    ).not.toThrow();
    expect(() => assertRoleNameAllowed('Kho', 'Kho tổng')).not.toThrow();
  });

  it('the Super Admin role cannot be deleted; its permissions only by a Super Admin', () => {
    expect(() => assertCanEditRole('Super Admin', owner, 'delete')).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertCanEditRole('Super Admin', admin, 'permissions'),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertCanEditRole('Super Admin', owner, 'permissions'),
    ).not.toThrow();
    expect(() => assertCanEditRole('Kho', admin, 'delete')).not.toThrow();
  });
});
