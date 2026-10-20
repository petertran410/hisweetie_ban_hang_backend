// prisma/seeds/add-cash-advance-permissions.ts
//
// Mục đích: upsert quyền cho trang Tạm ứng (/tai-chinh/tam-ung) và Hoàn ứng
// (/tai-chinh/hoan-ung). Chỉ thêm / cập nhật quyền: KHÔNG xóa quyền nào và
// KHÔNG tự gán cho role/user — gán quyền theo chi nhánh trên trang phân quyền.
//
// Quyền KHÔNG gắn chi nhánh trong tên. User làm được việc X ở kho B khi B
// thuộc danh sách chi nhánh của user và vai trò của user tại B có quyền X.
// Người nhận tạm ứng cần quyền xem để vào trang upload phiếu đã ký.
//
// Cách chạy:
//   yarn seed:cash-advance-permissions

import { PrismaClient } from '@prisma/client';
import {
  upsertFinancePermissions,
  type PermissionSeed,
} from './lib/finance-permissions';

const prisma = new PrismaClient();

const group = (
  resource: string,
  actions: Array<[action: string, description: string]>,
): PermissionSeed[] =>
  actions.map(([action, description]) => ({ resource, action, description }));

const PERMISSIONS: PermissionSeed[] = [
  ...group('cash_advance', [
    ['view', 'Xem phiếu tạm ứng (người nhận upload phiếu đã ký)'],
    ['create', 'Tạo phiếu tạm ứng từ quỹ kho'],
    ['update', 'Sửa phiếu tạm ứng chưa giao tiền (của người khác)'],
    ['confirm', 'Xác nhận giao tiền tạm ứng (trừ quỹ kho)'],
    ['cancel', 'Hủy phiếu tạm ứng'],
  ]),
  ...group('cash_advance_refund', [
    ['view', 'Xem phiếu hoàn ứng'],
    ['create', 'Tạo phiếu hoàn ứng'],
    ['update', 'Sửa phiếu hoàn ứng chưa nhận tiền (của người khác)'],
    ['confirm', 'Xác nhận nhận tiền hoàn ứng (cộng quỹ kho)'],
    ['cancel', 'Hủy phiếu hoàn ứng'],
  ]),
];

async function main() {
  console.log('🌱 Upsert quyền Tạm ứng / Hoàn ứng...');
  const { created, updated } = await upsertFinancePermissions(
    prisma,
    PERMISSIONS,
  );
  console.log(`🎉 Xong: tạo mới ${created}, cập nhật ${updated}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
