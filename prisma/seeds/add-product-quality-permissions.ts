// prisma/seeds/add-product-quality-permissions.ts
//
// Upsert quyền module Quản lý Chất Lượng Sản Phẩm (product_quality).
// Thiết kế idempotent, không xóa, không reset dữ liệu.
//
// Cách chạy: yarn seed:product-quality-permissions

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionSeed {
  name: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  category: string;
}

const PERMISSIONS: PermissionSeed[] = [
  {
    name: 'product_quality:view',
    resource: 'product_quality',
    action: 'view',
    scope: 'all',
    description: 'Xem danh sách và chi tiết phiếu chất lượng hàng hóa',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:view_all_branches',
    resource: 'product_quality',
    action: 'view_all_branches',
    scope: 'all',
    description: 'Xem phiếu chất lượng của tất cả chi nhánh',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:create',
    resource: 'product_quality',
    action: 'create',
    scope: 'all',
    description: 'Tạo phiếu chất lượng hàng hóa',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:update',
    resource: 'product_quality',
    action: 'update',
    scope: 'all',
    description: 'Chỉnh sửa thông tin phiếu chất lượng',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:assign',
    resource: 'product_quality',
    action: 'assign',
    scope: 'all',
    description: 'Cập nhật hướng xử lý và phân công người quyết định',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:complete',
    resource: 'product_quality',
    action: 'complete',
    scope: 'all',
    description: 'Cập nhật phản hồi và đánh dấu hoàn thành nhiệm vụ bộ phận',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:close',
    resource: 'product_quality',
    action: 'close',
    scope: 'all',
    description: 'Kết thúc phiếu chất lượng thủ công (ENDED)',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:delete',
    resource: 'product_quality',
    action: 'delete',
    scope: 'all',
    description: 'Xóa phiếu chất lượng mới tạo chưa xử lý',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:export',
    resource: 'product_quality',
    action: 'export',
    scope: 'all',
    description: 'Xuất dữ liệu phiếu chất lượng ra Excel',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:import',
    resource: 'product_quality',
    action: 'import',
    scope: 'all',
    description: 'Import dữ liệu phiếu chất lượng từ LarkBase',
    category: 'Sản phẩm',
  },
  {
    name: 'product_quality:configure',
    resource: 'product_quality',
    action: 'configure',
    scope: 'all',
    description: 'Cấu hình routing người quyết định và danh sách bộ phận',
    category: 'Sản phẩm',
  },
];

async function main() {
  console.log('🌱 Upserting product quality permissions...');
  for (const perm of PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {
        description: perm.description,
        category: perm.category,
      },
      create: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        scope: perm.scope,
        description: perm.description,
        category: perm.category,
      },
    });
    console.log(`  ✓ ${p.name}`);
  }
  console.log('✅ Hoàn tất upsert product quality permissions.');
}

main()
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
