// prisma/seeds/add-note-templates-permission.ts
//
// Idempotent + non-destructive: chỉ upsert permission `note_templates:manage`
// và gán cho role Super Admin + Admin (nếu tồn tại). KHÔNG xóa / KHÔNG reset
// bất kỳ dữ liệu nào. An toàn chạy lại nhiều lần.
//
// Quyền này điều khiển việc TẠO / SỬA / XÓA mẫu ghi chú có sẵn trên card sản
// phẩm ở trang Bán hàng:
//   - Có quyền  → thấy nút "Tạo ghi chú có sẵn" + icon sửa mẫu.
//   - Không có  → nút và icon bị ẩn, nhưng vẫn xem / tìm / chọn ghi chú và
//                 tự nhập "Ấn vào để thêm ghi chú khác" bình thường.
// Backend cũng chặn POST/PUT/DELETE /api/note-templates bằng đúng quyền này.
//
// Cách chạy (từ thư mục hisweetie_ban_hang_backend/):
//   npx ts-node prisma/seeds/add-note-templates-permission.ts
// hoặc dùng script đã khai báo trong package.json:
//   yarn seed:note-templates
//
// Lưu ý: KHÔNG chạy `yarn seed` (toàn bộ) vì các seed khác có thể reset data.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    name: 'note_templates:manage',
    resource: 'note_templates',
    action: 'manage',
    description: 'Tạo / sửa / xóa mẫu ghi chú có sẵn trên card sản phẩm (POS)',
    category: 'Bán hàng',
  },
];

async function main() {
  console.log('🌱 Adding note_templates:manage permission...');

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

  for (const roleName of ['Super Admin', 'Admin']) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.log(`⚠️  Role "${roleName}" không tồn tại — bỏ qua.`);
      continue;
    }

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
    console.log(`✅ Assigned to ${roleName}`);
  }

  console.log(
    '🎉 Done — không có dữ liệu hiện tại nào bị ảnh hưởng. ' +
      'Gán quyền cho các role khác trong trang Cài đặt → Vai trò.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
