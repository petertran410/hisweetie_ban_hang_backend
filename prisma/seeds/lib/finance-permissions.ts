import { PrismaClient } from '@prisma/client';

export interface PermissionSeed {
  resource: string;
  action: string;
  description: string;
}

/**
 * Upsert quyền nhóm "Tài chính". Quyền không gắn chi nhánh trong tên: chi nhánh
 * do việc gán vai trò theo chi nhánh quyết định.
 */
export async function upsertFinancePermissions(
  prisma: PrismaClient,
  permissions: PermissionSeed[],
) {
  let created = 0;
  let updated = 0;
  for (const permission of permissions) {
    const name = `${permission.resource}:${permission.action}`;
    const data = {
      resource: permission.resource,
      action: permission.action,
      scope: 'all',
      category: 'Tài chính',
      description: permission.description,
    };
    const existing = await prisma.permission.findUnique({ where: { name } });
    if (existing) {
      await prisma.permission.update({ where: { name }, data });
      updated += 1;
      continue;
    }
    await prisma.permission.create({ data: { name, ...data } });
    created += 1;
    console.log(`  ✅ Đã tạo "${name}".`);
  }
  return { created, updated };
}

/**
 * Xóa các quyền kiểu cũ có hậu tố chi nhánh (`_hn`, `_sg`, `_vp`) của các nhóm
 * đã nêu, kèm mọi liên kết vai trò / user của chúng.
 */
export async function removeBranchSuffixedPermissions(
  prisma: PrismaClient,
  resources: string[],
) {
  const stale = (
    await prisma.permission.findMany({
      where: { resource: { in: resources } },
      select: { id: true, name: true, action: true },
    })
  ).filter((permission) => /_(hn|sg|vp)$/.test(permission.action));
  return deletePermissions(prisma, stale);
}

/** Xóa các quyền không còn dùng theo tên, kèm liên kết vai trò / user. */
export async function removePermissions(prisma: PrismaClient, names: string[]) {
  return deletePermissions(
    prisma,
    await prisma.permission.findMany({
      where: { name: { in: names } },
      select: { id: true, name: true },
    }),
  );
}

async function deletePermissions(
  prisma: PrismaClient,
  stale: Array<{ id: number; name: string }>,
) {
  if (!stale.length) return 0;
  const permissionId = { in: stale.map((permission) => permission.id) };
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { permissionId } }),
    prisma.roleBranchPermission.deleteMany({ where: { permissionId } }),
    prisma.userPermission.deleteMany({ where: { permissionId } }),
    prisma.userBranchPermission.deleteMany({ where: { permissionId } }),
    prisma.permission.deleteMany({ where: { id: permissionId } }),
  ]);
  for (const permission of stale)
    console.log(`  🗑  Đã xóa quyền không còn dùng "${permission.name}".`);
  return stale.length;
}
