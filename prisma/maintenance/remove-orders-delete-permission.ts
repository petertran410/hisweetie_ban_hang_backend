import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY_FLAG = '--apply';

async function main() {
  const permissions = await prisma.permission.findMany({
    where: {
      resource: 'orders',
      action: 'delete',
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: { id: 'asc' },
  });

  if (permissions.length === 0) {
    console.log('Không tìm thấy quyền orders:delete. Không có gì để xử lý.');
    return;
  }

  console.log(
    `Tìm thấy ${permissions.length} quyền sẽ xóa: ${permissions
      .map((permission) => `${permission.name} (id=${permission.id})`)
      .join(', ')}`,
  );

  if (!process.argv.includes(APPLY_FLAG)) {
    console.log(
      `Chưa thay đổi DB. Chạy lại với "${APPLY_FLAG}" để xóa quyền ` +
        'orders:delete và các gán quyền liên quan.',
    );
    return;
  }

  const result = await prisma.permission.deleteMany({
    where: {
      id: { in: permissions.map((permission) => permission.id) },
    },
  });

  console.log(
    `Đã xóa ${result.count} quyền orders:delete. Các gán quyền liên quan ` +
      'được xóa theo quan hệ cascade của Permission.',
  );
}

main()
  .catch((error) => {
    console.error('Xóa quyền orders:delete thất bại:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
