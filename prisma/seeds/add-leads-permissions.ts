// prisma/seeds/add-leads-permissions.ts
//
// Thêm quyền cho trang Lead (/khach-hang/lead) — khách tiềm năng CSKH chăm sóc rồi chuyển Sale PIC.
//   - leads:view    Xem lead (chỉ có quyền này = Sale: chỉ thấy lead giao cho mình)
//   - leads:update  Tạo / sửa lead (CSKH, xem mọi lead)
//   - leads:assign  Chuyển giao lead cho Sale PIC (gửi Lark + kết bạn, tin chào Zalo)
//
// KHÔNG gán quyền cho role/user, không xoá gì. Chạy lại nhiều lần vẫn an toàn.
//
// Cách chạy:  yarn seed:leads-permissions

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  { action: 'view', description: 'Xem lead' },
  { action: 'update', description: 'Tạo / sửa lead' },
  { action: 'assign', description: 'Chuyển giao lead cho Sale PIC' },
].map((p) => ({
  ...p,
  name: `leads:${p.action}`,
  resource: 'leads',
  scope: 'all',
  category: 'Khách hàng',
}));

async function main() {
  for (const p of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { name: p.name },
    });
    if (existing) {
      console.log(`  ↷ Đã tồn tại "${p.name}". Bỏ qua.`);
      continue;
    }
    const created = await prisma.permission.create({ data: p });
    console.log(`  ✅ Đã tạo "${created.name}" (id=${created.id}).`);
  }
}

main()
  .then(() => console.log('🎉 Hoàn tất.'))
  .catch((e) => {
    console.error('❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
