// prisma/seeds/add-debt-tracking-permissions.ts
//
// Thêm quyền cho tính năng THEO DÕI CÔNG NỢ KHÁCH HÀNG + TICKET ĐÒI NỢ.
//
// AN TOÀN: chỉ upsert theo `name`. KHÔNG xóa, KHÔNG reset, KHÔNG đụng tới
// bất kỳ quyền nào ngoài danh sách dưới đây. Phân quyền thủ công hiện có
// của các role/user khác được giữ nguyên.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORY = 'Khách hàng';

const NEW_PERMISSIONS = [
  // ---- Theo dõi công nợ ----
  {
    name: 'debt_tracking:view',
    resource: 'debt_tracking',
    action: 'view',
    description: 'Xem trang theo dõi công nợ khách hàng',
    category: CATEGORY,
  },
  {
    name: 'debt_tracking:update_policy',
    resource: 'debt_tracking',
    action: 'update_policy',
    description: 'Thiết lập hình thức / hạn mức / kỳ hạn công nợ của khách',
    category: CATEGORY,
  },
  {
    name: 'debt_tracking:export',
    resource: 'debt_tracking',
    action: 'export',
    description: 'Xuất Excel danh sách theo dõi công nợ',
    category: CATEGORY,
  },

  // ---- Ticket đòi nợ ----
  {
    name: 'debt_tickets:view',
    resource: 'debt_tickets',
    action: 'view',
    description: 'Xem phiếu thu hồi nợ',
    category: CATEGORY,
  },
  {
    name: 'debt_tickets:create',
    resource: 'debt_tickets',
    action: 'create',
    description: 'Tạo phiếu thu hồi nợ',
    category: CATEGORY,
  },
  {
    name: 'debt_tickets:update',
    resource: 'debt_tickets',
    action: 'update',
    description: 'Cập nhật phiếu thu hồi nợ',
    category: CATEGORY,
  },
  {
    name: 'debt_tickets:cancel',
    resource: 'debt_tickets',
    action: 'cancel',
    description: 'Hủy / kết thúc phiếu thu hồi nợ',
    category: CATEGORY,
  },
];

/** Quyền cấp cho Admin (không gồm quyền ghi chú của bộ phận khác). */
const ADMIN_PERMISSIONS = [
  'debt_tracking:view',
  'debt_tracking:update_policy',
  'debt_tracking:export',
  'debt_tickets:view',
  'debt_tickets:create',
  'debt_tickets:update',
  'debt_tickets:cancel',
];

async function main() {
  console.log('🌱 Thêm quyền theo dõi công nợ...');

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
    console.log(`  ✅ Upserted: ${perm.name}`);
  }

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
        create: { roleId: superAdminRole.id, permissionId: perm.id },
      });
    }
    console.log('✅ Đã gán toàn bộ cho Super Admin');
  }

  const adminRole = await prisma.role.findUnique({ where: { name: 'Admin' } });
  if (adminRole) {
    const adminPerms = createdPerms.filter((p) =>
      ADMIN_PERMISSIONS.includes(p.name),
    );
    for (const perm of adminPerms) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: { roleId: adminRole.id, permissionId: perm.id },
      });
    }
    console.log('✅ Đã gán cho Admin');
  }

  console.log('🎉 Xong — không có dữ liệu hiện tại nào bị ảnh hưởng.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
