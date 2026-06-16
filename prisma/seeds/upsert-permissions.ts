// prisma/seeds/upsert-permissions.ts
//
// Mục đích: Thêm/cập nhật (UPSERT) một DANH SÁCH quyền vào bảng `permissions`
// một cách AN TOÀN và idempotent. File này được thiết kế để KHÔNG bao giờ:
//   - Xóa hay reset bất kỳ quyền nào (không deleteMany).
//   - Đụng tới phân quyền của role/user (không tự gán, không gỡ).
//   - Sửa các quyền không nằm trong danh sách PERMISSIONS bên dưới.
// Chạy lại nhiều lần vẫn an toàn: quyền đã có thì cập nhật metadata, chưa có
// thì tạo mới.
//
// ⚠️ KHÁC HẲN `seed:permissions` (file đó xóa sạch rồi tạo lại — làm mất phân
// quyền thủ công). File này CHỈ thêm/cập nhật.
//
// Cách dùng:
//   1. Thêm các quyền cần upsert vào mảng PERMISSIONS bên dưới.
//   2. Chạy:  yarn seed:upsert-permissions
//   3. Vào giao diện phân quyền để GÁN quyền mới cho role/user mong muốn.
//      (File này cố ý KHÔNG tự gán cho bất kỳ role nào.)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionSeed {
  resource: string;
  action: string;
  scope?: string; // mặc định 'all'
  field?: string | null; // mặc định null
  name?: string; // mặc định `${resource}:${action}`
  description?: string;
  category?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// DANH SÁCH QUYỀN CẦN UPSERT — chỉnh sửa tại đây.
// Hiện để trống: tính năng cô lập dữ liệu theo nhà cung cấp KHÔNG cần quyền
// mới (tái dùng order_suppliers:* và vehicle_shipments:* đã có sẵn).
// Khi cần thêm quyền mới trong tương lai, thêm phần tử vào mảng này, ví dụ:
//   {
//     resource: 'order_suppliers',
//     action: 'view_factory_price',
//     description: 'Xem giá nhà máy trên phiếu đặt hàng nhập',
//     category: 'Đặt hàng nhập',
//   },
// ───────────────────────────────────────────────────────────────────────────
const PERMISSIONS: PermissionSeed[] = [
  {
    resource: 'order_suppliers',
    action: 'view_price',
    description: 'Xem đơn giá / giảm giá / thành tiền trên phiếu đặt hàng nhập',
    category: 'Nhà cung cấp',
  },
  {
    resource: 'order_suppliers',
    action: 'view_factory_price',
    description: 'Xem đơn giá nhà máy (NM) trên phiếu đặt hàng nhập',
    category: 'Nhà cung cấp',
  },
  {
    resource: 'order_suppliers',
    action: 'view_stage_factory',
    description: 'Xem giai đoạn hiện tại & tên nhà máy trên đặt hàng nhập chi tiết',
    category: 'Nhà cung cấp',
  },
  {
    resource: 'order_suppliers',
    action: 'edit_stage_factory',
    description: 'Sửa giai đoạn hiện tại & tên nhà máy trên đặt hàng nhập chi tiết',
    category: 'Nhà cung cấp',
  },
];

async function main() {
  if (PERMISSIONS.length === 0) {
    console.log(
      '⚠️  Mảng PERMISSIONS đang trống — không có quyền nào để upsert. ' +
        'Hãy thêm quyền vào file rồi chạy lại.',
    );
    return;
  }

  console.log(
    `🌱 Upsert ${PERMISSIONS.length} quyền (chỉ thêm/cập nhật, không xóa, không gán role)...`,
  );

  let created = 0;
  let updated = 0;

  for (const p of PERMISSIONS) {
    const scope = p.scope ?? 'all';
    const field = p.field ?? null;
    const name = p.name ?? `${p.resource}:${p.action}`;

    // Khóa định danh: @@unique([resource, action, scope, field]) trên Permission.
    const existing = await prisma.permission.findFirst({
      where: { resource: p.resource, action: p.action, scope, field },
    });

    if (existing) {
      await prisma.permission.update({
        where: { id: existing.id },
        data: {
          name,
          description: p.description ?? existing.description,
          category: p.category ?? existing.category,
        },
      });
      updated++;
      console.log(`  ↻ Cập nhật "${name}" (id=${existing.id}).`);
    } else {
      const row = await prisma.permission.create({
        data: {
          name,
          resource: p.resource,
          action: p.action,
          scope,
          field,
          description: p.description,
          category: p.category,
        },
      });
      created++;
      console.log(`  ✅ Tạo mới "${name}" (id=${row.id}).`);
    }
  }

  console.log(`\n📊 Kết quả: tạo mới ${created}, cập nhật ${updated}.`);
  console.log(
    '👉 Hãy gán các quyền mới cho role/user qua giao diện phân quyền. ' +
      'File này cố ý không tự gán.',
  );
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi khi upsert quyền:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
