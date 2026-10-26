// prisma/seeds/add-smax-chat-permissions.ts
//
// Thêm quyền cho Sidebar chat Zalo (Smax) trên POS. Người dùng chat bằng kênh
// Zalo đã liên kết với chính tài khoản mình (/cai-dat/smax).
//   - smax_chat:view            Xem chat Zalo
//   - smax_chat:send            Gửi tin Zalo
//   - smax_chat:manage_contacts Quản lý ID Zalo / nhóm Zalo của khách
//
// KHÔNG gán quyền cho role/user, không xoá gì. Chạy lại nhiều lần vẫn an toàn.
//
// Cách chạy:  yarn seed:smax-chat-permissions

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  { action: 'view', description: 'Xem chat Zalo' },
  { action: 'send', description: 'Gửi tin Zalo' },
  { action: 'manage_contacts', description: 'Quản lý ID Zalo của khách' },
].map((p) => ({
  ...p,
  name: `smax_chat:${p.action}`,
  resource: 'smax_chat',
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
