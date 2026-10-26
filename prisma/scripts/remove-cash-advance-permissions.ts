// prisma/scripts/remove-cash-advance-permissions.ts
//
// Gỡ các quyền của tính năng Tạm ứng / Hoàn ứng đã bỏ: mọi quyền có resource
// `cash_advance` hoặc `cash_advance_refund`, kèm mọi lượt gán của chúng cho vai
// trò, vai trò theo chi nhánh, user và user theo chi nhánh. Không đụng quyền
// nào khác. Chạy thử chỉ đọc DB và in ra những gì sẽ xóa.
//
// Cách chạy:
//   yarn remove:cash-advance-permissions            # chạy thử, không ghi
//   yarn remove:cash-advance-permissions --apply    # xóa thật
//
// Sau khi xóa, backend tự cập nhật quyền trong tối đa 60 giây (cache quyền).

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { removePermissions } from '../seeds/lib/finance-permissions';

const RESOURCES = ['cash_advance', 'cash_advance_refund'];

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const permissions = await prisma.permission.findMany({
      where: { resource: { in: RESOURCES } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (!permissions.length) {
      console.log('Không còn quyền Tạm ứng / Hoàn ứng nào trong DB.');
      return;
    }

    console.log(
      `${apply ? 'Xóa' : '[Chạy thử] Sẽ xóa'} ${permissions.length} quyền:`,
    );
    for (const permission of permissions) {
      const where = { permissionId: permission.id };
      const [roles, roleBranches, users, userBranches] = await Promise.all([
        prisma.rolePermission.count({ where }),
        prisma.roleBranchPermission.count({ where }),
        prisma.userPermission.count({ where }),
        prisma.userBranchPermission.count({ where }),
      ]);
      console.log(
        `  - ${permission.name}: gán cho ${roles} vai trò, ${roleBranches} vai trò theo chi nhánh, ${users} user, ${userBranches} user theo chi nhánh`,
      );
    }

    if (!apply) {
      console.log('\nChưa xóa gì. Thêm --apply để xóa thật.');
      return;
    }
    const removed = await removePermissions(
      prisma,
      permissions.map((permission) => permission.name),
    );
    console.log(`\n🎉 Đã xóa ${removed} quyền cùng các lượt gán.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
