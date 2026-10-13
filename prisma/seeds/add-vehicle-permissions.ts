// prisma/seeds/add-vehicle-permissions.ts
//
// Mục đích: upsert các quyền cho tính năng "Xe cộ" (xăng dầu, chăm sóc xe,
// danh sách xe) ở /tai-chinh/xe-co, đồng thời xóa các quyền kiểu cũ có hậu tố
// chi nhánh (vehicles:view_hn, vehicles:view_sg, ...).
//
// Quyền KHÔNG gắn chi nhánh trong tên. User làm được việc X ở kho B khi B thuộc
// danh sách chi nhánh của user và vai trò của user tại B có quyền X.
//
// File không tự gán quyền cho role/user. Chạy lại nhiều lần vẫn an toàn.
//
// Cách chạy:
//   yarn seed:vehicles

import { PrismaClient } from '@prisma/client';
import {
  removeBranchSuffixedPermissions,
  upsertFinancePermissions,
} from './lib/finance-permissions';

const prisma = new PrismaClient();

const PERMISSIONS = [
  ['view', 'Xem phiếu xăng dầu, chăm sóc xe và danh sách xe'],
  ['create', 'Tạo phiếu xăng dầu, chăm sóc xe'],
  ['update', 'Sửa, hủy phiếu xăng dầu, chăm sóc xe'],
  ['manage', 'Thêm, sửa, ngừng dùng xe trong danh sách xe'],
].map(([action, description]) => ({
  resource: 'vehicles',
  action,
  description,
}));

async function main() {
  console.log(`🌱 Upsert ${PERMISSIONS.length} quyền cho Xe cộ...`);
  const removed = await removeBranchSuffixedPermissions(prisma, ['vehicles']);
  const { created, updated } = await upsertFinancePermissions(
    prisma,
    PERMISSIONS,
  );
  console.log(
    `📊 Tổng kết: tạo mới ${created}, cập nhật ${updated}, xóa quyền kiểu cũ ${removed}.`,
  );
  console.log(
    '👉 Seed này không tự gán quyền. Hãy gán quyền cho vai trò theo từng chi nhánh qua giao diện phân quyền.',
  );
}

main()
  .then(() => {
    console.log('🎉 Hoàn tất.');
  })
  .catch((error) => {
    console.error('❌ Lỗi khi thêm quyền vehicles:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
