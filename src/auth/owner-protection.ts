import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Super Admin = owner hệ thống, được bypass mọi kiểm tra quyền (theo TÊN role).
 * Vì vậy role và tài khoản Super Admin phải được khoá chặt: chỉ Super Admin mới
 * gán/gỡ role này hay sửa/xoá/khoá tài khoản Super Admin; role không được đổi
 * tên/xoá; không role nào khác được đặt trùng tên.
 */
export const SUPER_ADMIN_ROLE = 'Super Admin';

type Actor = { id?: number; roles?: string[] } | null | undefined;
type Db = Pick<PrismaService, 'role' | 'userRole'>;

export const isSuperAdmin = (actor: Actor): boolean =>
  !!actor?.roles?.includes(SUPER_ADMIN_ROLE);

/** So khớp không phân biệt hoa thường / khoảng trắng hai đầu. */
export const isSuperAdminRoleName = (name?: string | null): boolean =>
  (name ?? '').trim().toLowerCase() === SUPER_ADMIN_ROLE.toLowerCase();

async function superAdminRoleId(db: Db): Promise<number | null> {
  const role = await db.role.findUnique({
    where: { name: SUPER_ADMIN_ROLE },
    select: { id: true },
  });
  return role?.id ?? null;
}

export async function isUserSuperAdmin(
  db: Db,
  userId: number,
): Promise<boolean> {
  const row = await db.userRole.findFirst({
    where: { userId, role: { name: SUPER_ADMIN_ROLE } },
    select: { userId: true },
  });
  return !!row;
}

const ownerOnly = (message: string) => new ForbiddenException(message);

/** Tài khoản đích là Super Admin → chỉ Super Admin khác mới được đụng vào. */
export async function assertCanManageUser(
  db: Db,
  actor: Actor,
  targetUserId: number,
): Promise<void> {
  if (isSuperAdmin(actor)) return;
  if (await isUserSuperAdmin(db, targetUserId)) {
    throw ownerOnly('Chỉ Super Admin mới được thay đổi tài khoản Super Admin.');
  }
}

/** Gán role Super Admin (toàn cục hoặc theo chi nhánh) → chỉ Super Admin. */
export async function assertCanAssignRoles(
  db: Db,
  actor: Actor,
  roleIds: Array<number | null | undefined> | undefined,
): Promise<void> {
  if (!roleIds?.length || isSuperAdmin(actor)) return;
  const ownerRoleId = await superAdminRoleId(db);
  if (ownerRoleId != null && roleIds.some((id) => Number(id) === ownerRoleId)) {
    throw ownerOnly('Chỉ Super Admin mới được gán vai trò Super Admin.');
  }
}

/** Hệ thống luôn phải còn ít nhất 1 Super Admin đang hoạt động. */
export async function assertNotLastSuperAdmin(
  db: Db,
  targetUserId: number,
): Promise<void> {
  if (!(await isUserSuperAdmin(db, targetUserId))) return;
  const others = await db.userRole.count({
    where: {
      role: { name: SUPER_ADMIN_ROLE },
      userId: { not: targetUserId },
      user: { isActive: true },
    },
  });
  if (others === 0) {
    throw new BadRequestException(
      'Không thể gỡ, khoá hoặc xoá Super Admin cuối cùng của hệ thống.',
    );
  }
}

/** Sửa user: gom các kiểm tra owner cho PUT /users/:id. */
export async function assertUserUpdateAllowed(
  db: Db,
  actor: Actor,
  targetUserId: number,
  change: { roleIds?: number[]; isActive?: boolean },
): Promise<void> {
  await assertCanManageUser(db, actor, targetUserId);
  await assertCanAssignRoles(db, actor, change.roleIds);

  const deactivating = change.isActive === false;
  let droppingOwnerRole = false;
  if (change.roleIds !== undefined) {
    const ownerRoleId = await superAdminRoleId(db);
    droppingOwnerRole =
      ownerRoleId != null &&
      !change.roleIds.some((id) => Number(id) === ownerRoleId);
  }
  if (deactivating || droppingOwnerRole) {
    await assertNotLastSuperAdmin(db, targetUserId);
  }
}

/** Sửa quyền của role Super Admin → chỉ Super Admin; xoá role này → không ai được. */
export function assertCanEditRole(
  roleName: string | null,
  actor: Actor,
  action: 'permissions' | 'delete',
): void {
  if (!isSuperAdminRoleName(roleName)) return;
  if (action === 'delete') {
    throw new BadRequestException('Không thể xoá vai trò Super Admin.');
  }
  if (!isSuperAdmin(actor)) {
    throw ownerOnly(
      'Chỉ Super Admin mới được sửa quyền của vai trò Super Admin.',
    );
  }
}

/** Đổi tên / xoá role Super Admin, hoặc đặt role khác trùng tên → chặn. */
export function assertRoleNameAllowed(
  currentName: string | null,
  nextName: string | undefined,
): void {
  if (nextName === undefined) return;
  if (isSuperAdminRoleName(currentName)) {
    if (nextName !== currentName) {
      throw new BadRequestException('Không thể đổi tên vai trò Super Admin.');
    }
    return;
  }
  if (isSuperAdminRoleName(nextName)) {
    throw new BadRequestException(
      'Tên "Super Admin" dành riêng cho vai trò hệ thống.',
    );
  }
}
