/**
 * Script AN TOÀN — chỉ THÊM 2 quyền chi tiết cho sản phẩm và gán cho
 * Super Admin + Admin. KHÔNG xóa bất kỳ dữ liệu phân quyền nào hiện có.
 *
 * Quyền thêm:
 *   - products:view_sale_price   (Xem giá bán)
 *   - products:view_publication  (Xem thông tin công bố)
 *
 * Chạy: npx ts-node prisma/seeds/add-product-granular-permissions.ts
 *
 * Idempotent: chạy nhiều lần không tạo trùng (dùng upsert theo unique
 * [resource, action, scope, field] và khóa chính RolePermission).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'products:view_sale_price',
    resource: 'products',
    action: 'view_sale_price',
    description: 'Xem giá bán sản phẩm',
    category: 'Sản phẩm',
    scope: 'all',
  },
  {
    name: 'products:view_publication',
    resource: 'products',
    action: 'view_publication',
    description: 'Xem thông tin công bố sản phẩm',
    category: 'Sản phẩm',
    scope: 'all',
  },
];

// Các role mặc định được nhận quyền mới. Super Admin vốn được bypass ở code,
// nhưng vẫn gán để nhất quán dữ liệu. User thường KHÔNG nhận (giữ mặc định ẩn).
const ROLES_TO_GRANT = ['Super Admin', 'Admin'];

async function main() {
  console.log('🔐 Thêm quyền chi tiết cho sản phẩm (an toàn, không xóa)...');

  const createdPermissionIds: number[] = [];

  for (const perm of NEW_PERMISSIONS) {
    // Prisma 4.x không chấp nhận null trong compound unique [resource,action,
    // scope,field] → dùng findFirst rồi create/update thay cho upsert.
    const existing = await prisma.permission.findFirst({
      where: {
        resource: perm.resource,
        action: perm.action,
        scope: perm.scope,
      },
    });

    const saved = existing
      ? await prisma.permission.update({
          where: { id: existing.id },
          data: {
            name: perm.name,
            description: perm.description,
            category: perm.category,
          },
        })
      : await prisma.permission.create({
          data: {
            name: perm.name,
            resource: perm.resource,
            action: perm.action,
            scope: perm.scope,
            description: perm.description,
            category: perm.category,
          },
        });

    createdPermissionIds.push(saved.id);
    console.log(`  ✓ permission: ${perm.name} (id=${saved.id})`);
  }

  for (const roleName of ROLES_TO_GRANT) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.log(`  ⚠ Bỏ qua role "${roleName}" (không tồn tại)`);
      continue;
    }
    for (const permissionId of createdPermissionIds) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId },
        },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
    console.log(`  ✓ gán ${createdPermissionIds.length} quyền cho role "${roleName}"`);
  }

  // Bump permissionVersion để buộc các user đang đăng nhập làm mới quyền.
  const bumped = await prisma.user.updateMany({
    data: { permissionVersion: { increment: 1 } },
  });
  console.log(`  ✓ bump permissionVersion cho ${bumped.count} user`);

  console.log('🎉 Hoàn tất. Không có dữ liệu nào bị xóa.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
