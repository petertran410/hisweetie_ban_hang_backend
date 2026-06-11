// prisma/seeds/add-report-permissions.ts
//
// Thêm bộ quyền CHI TIẾT cho trang Báo cáo (mỗi loại báo cáo / ViewType = 1 quyền),
// tham khảo cây phân quyền của KiotViet. Chỉ tạo quyền cho báo cáo BACKEND THỰC SỰ CÓ.
//
// AN TOÀN — script này CHỈ insert/upsert:
//   - Không deleteMany, không reset bảng permission/rolePermission.
//   - Upsert 27 quyền (chưa có thì tạo, đã có thì cập nhật description/category).
//   - Gán cho Super Admin + Admin qua rolePermission.upsert (không xóa quyền cũ).
//   - KHÔNG đụng tới các quyền hiện có (kể cả 3 quyền report thô cũ:
//     reports:sales / reports:inventory / reports:customer — để nguyên).
//
// Chạy: npx ts-node prisma/seeds/add-report-permissions.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionData {
  name: string;
  resource: string;
  action: string;
  description: string;
  category: string;
}

// Category dùng chung cho toàn bộ quyền báo cáo (khớp seed gốc + icon FE 📊).
const CATEGORY = 'Báo cáo';

const reportPermissions: PermissionData[] = [
  // ── Cuối ngày (EOD) ──
  {
    name: 'reports:eod_synthetic',
    resource: 'reports',
    action: 'eod_synthetic',
    description: 'Báo cáo cuối ngày - Tổng hợp',
    category: CATEGORY,
  },
  {
    name: 'reports:eod_document',
    resource: 'reports',
    action: 'eod_document',
    description: 'Báo cáo cuối ngày - Bán hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:eod_cashflow',
    resource: 'reports',
    action: 'eod_cashflow',
    description: 'Báo cáo cuối ngày - Thu chi',
    category: CATEGORY,
  },
  {
    name: 'reports:eod_product',
    resource: 'reports',
    action: 'eod_product',
    description: 'Báo cáo cuối ngày - Hàng hóa',
    category: CATEGORY,
  },

  // ── Bán hàng (Sale) ──
  {
    name: 'reports:sale_time',
    resource: 'reports',
    action: 'sale_time',
    description: 'Báo cáo bán hàng - Thời gian',
    category: CATEGORY,
  },
  {
    name: 'reports:sale_profit',
    resource: 'reports',
    action: 'sale_profit',
    description: 'Báo cáo bán hàng - Lợi nhuận',
    category: CATEGORY,
  },
  {
    name: 'reports:sale_soldby',
    resource: 'reports',
    action: 'sale_soldby',
    description: 'Báo cáo bán hàng - Nhân viên',
    category: CATEGORY,
  },
  {
    name: 'reports:sale_branch',
    resource: 'reports',
    action: 'sale_branch',
    description: 'Báo cáo bán hàng - Chi nhánh',
    category: CATEGORY,
  },
  {
    name: 'reports:sale_refund',
    resource: 'reports',
    action: 'sale_refund',
    description: 'Báo cáo bán hàng - Trả hàng',
    category: CATEGORY,
  },

  // ── Hàng hóa (Product) ──
  {
    name: 'reports:product_sale',
    resource: 'reports',
    action: 'product_sale',
    description: 'Báo cáo hàng hóa - Bán hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:product_profit',
    resource: 'reports',
    action: 'product_profit',
    description: 'Báo cáo hàng hóa - Lợi nhuận',
    category: CATEGORY,
  },
  {
    name: 'reports:product_category',
    resource: 'reports',
    action: 'product_category',
    description: 'Báo cáo hàng hóa - Theo nhóm hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:product_inoutstock',
    resource: 'reports',
    action: 'product_inoutstock',
    description: 'Báo cáo hàng hóa - Xuất nhập tồn',
    category: CATEGORY,
  },
  {
    name: 'reports:product_inoutstock_detail',
    resource: 'reports',
    action: 'product_inoutstock_detail',
    description: 'Báo cáo hàng hóa - Xuất nhập tồn chi tiết',
    category: CATEGORY,
  },
  {
    name: 'reports:product_byuser',
    resource: 'reports',
    action: 'product_byuser',
    description: 'Báo cáo hàng hóa - Nhân viên theo hàng bán',
    category: CATEGORY,
  },
  {
    name: 'reports:product_bycustomer',
    resource: 'reports',
    action: 'product_bycustomer',
    description: 'Báo cáo hàng hóa - Khách theo hàng bán',
    category: CATEGORY,
  },
  {
    name: 'reports:product_bysupplier',
    resource: 'reports',
    action: 'product_bysupplier',
    description: 'Báo cáo hàng hóa - Nhà cung cấp theo hàng nhập',
    category: CATEGORY,
  },
  {
    name: 'reports:product_damage',
    resource: 'reports',
    action: 'product_damage',
    description: 'Báo cáo hàng hóa - Xuất hủy',
    category: CATEGORY,
  },

  // ── Khách hàng (Customer) ──
  {
    name: 'reports:customer_sale',
    resource: 'reports',
    action: 'customer_sale',
    description: 'Báo cáo khách hàng - Bán hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:customer_product',
    resource: 'reports',
    action: 'customer_product',
    description: 'Báo cáo khách hàng - Hàng bán theo khách',
    category: CATEGORY,
  },
  {
    name: 'reports:customer_debt',
    resource: 'reports',
    action: 'customer_debt',
    description: 'Báo cáo khách hàng - Công nợ',
    category: CATEGORY,
  },

  // ── Nhà cung cấp (Supplier) ──
  {
    name: 'reports:supplier_purchase',
    resource: 'reports',
    action: 'supplier_purchase',
    description: 'Báo cáo nhà cung cấp - Nhập hàng',
    category: CATEGORY,
  },
  {
    name: 'reports:supplier_byproduct',
    resource: 'reports',
    action: 'supplier_byproduct',
    description: 'Báo cáo nhà cung cấp - Hàng nhập theo nhà cung cấp',
    category: CATEGORY,
  },
  {
    name: 'reports:supplier_debt',
    resource: 'reports',
    action: 'supplier_debt',
    description: 'Báo cáo nhà cung cấp - Công nợ',
    category: CATEGORY,
  },
  {
    name: 'reports:supplier_return',
    resource: 'reports',
    action: 'supplier_return',
    description: 'Báo cáo nhà cung cấp - Trả hàng nhập',
    category: CATEGORY,
  },
  {
    name: 'reports:supplier_info',
    resource: 'reports',
    action: 'supplier_info',
    description: 'Báo cáo nhà cung cấp - Tổng hợp nhà cung cấp',
    category: CATEGORY,
  },

  // ── Tài chính (Financial) — gộp 1 quyền cho cả nhóm ──
  {
    name: 'reports:financial',
    resource: 'reports',
    action: 'financial',
    description: 'Xem báo cáo tài chính',
    category: CATEGORY,
  },
];

// Các role được gán sẵn toàn bộ quyền báo cáo chi tiết.
const ROLES_TO_GRANT = ['Super Admin', 'Admin'];

async function main() {
  console.log('🌱 Adding detailed report permissions (insert-only)...');

  // 1) Upsert quyền — không xóa, không reset.
  const upserted: { id: number; name: string }[] = [];
  for (const perm of reportPermissions) {
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
        description: perm.description,
        category: perm.category,
        scope: 'all',
      },
    });
    upserted.push({ id: p.id, name: p.name });
  }
  console.log(`  ✅ Upserted ${upserted.length} report permissions`);

  // 2) Gán cho Super Admin + Admin (upsert — không xóa quyền hiện có).
  for (const roleName of ROLES_TO_GRANT) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      console.log(`  ⚠ Role "${roleName}" không tồn tại — bỏ qua.`);
      continue;
    }
    for (const perm of upserted) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    console.log(
      `  ✅ Assigned ${upserted.length} report permissions to role "${roleName}"`,
    );
  }

  console.log('🎉 Done — không có dữ liệu hiện tại nào bị xóa hay ghi đè.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
