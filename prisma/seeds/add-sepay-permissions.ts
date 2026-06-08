import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'sepay:view',
    resource: 'sepay',
    action: 'view',
    description: 'Xem biến động số dư (giao dịch Sepay)',
    category: 'Tài chính',
  },
  {
    name: 'sepay:sync',
    resource: 'sepay',
    action: 'sync',
    description: 'Đồng bộ lịch sử giao dịch Sepay',
    category: 'Cấu hình',
  },
  {
    name: 'sepay:assign',
    resource: 'sepay',
    action: 'assign',
    description: 'Gán khách hàng cho giao dịch Sepay (biến động số dư)',
    category: 'Tài chính',
  },
  {
    name: 'sepay:confirm',
    resource: 'sepay',
    action: 'confirm',
    description: 'Xác nhận & tạo phiếu thu từ giao dịch Sepay',
    category: 'Tài chính',
  },
];

async function main() {
  console.log('🌱 Adding sepay permissions...');

  // Upsert từng permission — không xóa gì cả, chỉ thêm mới
  const createdPerms: { id: number; name: string }[] = [];
  for (const perm of NEW_PERMISSIONS) {
    const result = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {
        description: perm.description,
        category: perm.category,
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

  // Gán toàn bộ permission mới cho Super Admin + Admin (không đụng quyền hiện có)
  for (const roleName of ['Super Admin', 'Admin']) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;
    for (const perm of createdPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: perm.id,
        },
      });
    }
    console.log(`✅ Assigned all sepay permissions to ${roleName}`);
  }

  console.log(
    '🎉 Done — chỉ Super Admin + Admin được cấp. Không có dữ liệu phân quyền hiện tại nào bị ảnh hưởng.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
