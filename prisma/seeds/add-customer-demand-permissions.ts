// Additive permission upsert for Customer Demand.
// Không tự chạy; người dùng chủ động thực hiện theo quy định AGENTS.md.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  ['customer_demand:view', 'view', 'Xem Demand khách hàng (OEM/đặt hộ)'],
  ['customer_demand:create', 'create', 'Tạo phiếu Demand khách hàng ở trạng thái nháp'],
  ['customer_demand:update', 'update', 'Chỉnh sửa phiếu Demand khách hàng'],
  ['customer_demand:approve', 'approve', 'Duyệt tháng Demand khách hàng'],
  ['customer_demand:cancel', 'cancel', 'Hủy tháng Demand khách hàng'],
] as const;

async function main() {
  for (const [name, action, description] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name },
      create: {
        name,
        resource: 'customer_demand',
        action,
        scope: 'all',
        category: 'Khách hàng',
        description,
      },
      update: {
        resource: 'customer_demand',
        action,
        category: 'Khách hàng',
        description,
      },
    });
  }
  console.log(`Đã upsert ${PERMISSIONS.length} quyền customer_demand.`);
}

main()
  .catch((error) => {
    console.error('Không thể upsert quyền customer_demand:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
