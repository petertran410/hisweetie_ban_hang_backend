// prisma/seeds/add-contract-signer-permission.ts
//
// Idempotent + non-destructive: chỉ upsert permission `contracts:manage_signers`
// và gán cho role Super Admin + Admin (nếu tồn tại). KHÔNG xóa / KHÔNG ghi đè
// dữ liệu hiện có. An toàn chạy lại nhiều lần.
//
// Dùng để thêm 1 quyền mới cho tính năng "Người ký hợp đồng" (BÊN A) trong
// trang Cài đặt. Chạy SAU khi đã chạy add-contract-permissions.ts và code đã
// thêm route POST/PATCH/DELETE /contracts/signers ở controller.
//
// Cách chạy (từ thư mục hisweetie_ban_hang_backend/):
//   yarn seed --file prisma/seeds/add-contract-signer-permission.ts
// hoặc nếu có script riêng:
//   yarn seed:contract-signer
//
// Lưu ý: KHÔNG chạy `yarn seed` (toàn bộ) vì có thể có seed khác reset data.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'contracts:manage_signers',
    resource: 'contracts',
    action: 'manage_signers',
    description: 'Thêm / sửa / ẩn người ký hợp đồng BÊN A (Documenso user)',
    category: 'Khách hàng',
  },
];

async function main() {
  console.log('🌱 Adding contracts:manage_signers permission...');

  const createdPerms: { id: number; name: string }[] = [];
  for (const perm of NEW_PERMISSIONS) {
    const result = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {
        description: perm.description,
        category: perm.category,
        resource: perm.resource,
        action: perm.action,
      },
      create: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
        category: perm.category,
        scope: 'all',
      },
    });
    createdPerms.push(result);
    console.log(`  ✅ Upserted permission: ${perm.name}`);
  }

  // Gán cho Super Admin (nếu tồn tại).
  const superAdminRole = await prisma.role.findUnique({
    where: { name: 'Super Admin' },
  });
  if (superAdminRole) {
    for (const perm of createdPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: perm.id,
        },
      });
    }
    console.log('✅ Assigned to Super Admin');
  } else {
    console.log('⚠️  Role "Super Admin" không tồn tại — bỏ qua.');
  }

  // Gán cho Admin (nếu tồn tại).
  const adminRole = await prisma.role.findUnique({
    where: { name: 'Admin' },
  });
  if (adminRole) {
    for (const perm of createdPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: perm.id,
        },
      });
    }
    console.log('✅ Assigned to Admin');
  } else {
    console.log('⚠️  Role "Admin" không tồn tại — bỏ qua.');
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
