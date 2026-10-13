// prisma/seeds/add-warehouse-finance-permissions.ts
//
// Mục đích: upsert quyền cho luồng thu chi kho: Phiếu chi kho
// (/tai-chinh/phieu-chi-kho, /tai-chinh/approval-tuan), Tiền mặt kho
// (/tai-chinh/tien-mat-kho) và Quỹ nội bộ (/tai-chinh/quy-noi-bo), đồng thời
// xóa các quyền kiểu cũ có hậu tố chi nhánh (_hn/_sg/_vp) của các nhóm này.
//
// Quyền KHÔNG gắn chi nhánh trong tên. User làm được việc X ở chi nhánh B khi B
// thuộc danh sách chi nhánh của user và vai trò của user tại B có quyền X.
//
// File không tự gán quyền cho role/user. Chạy lại nhiều lần vẫn an toàn.
//
// Cách chạy:
//   yarn seed:warehouse-finance

import { PrismaClient } from '@prisma/client';
import {
  removeBranchSuffixedPermissions,
  removePermissions,
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
  ...group('warehouse_expense', [
    ['view', 'Xem phiếu chi kho và approval tuần'],
    ['create', 'Tạo khoản chi khác'],
    ['update', 'Sửa khoản chi khác'],
    ['prepare', 'Tổng hợp phiếu chi theo tuần'],
    ['submit', 'Tạo approval tuần trên Lark'],
    ['mark_issued', 'Tick Đã chi và ghi quỹ'],
    ['check_manager', 'Tick kiểm tra cột Quản lý kho'],
    ['check_accountant', 'Tick kiểm tra cột Kế toán kho'],
  ]),
  ...group('internal_fund', [
    ['view', 'Xem quỹ nội bộ'],
    ['create_receipt', 'Tạo phiếu thu quỹ'],
    ['transfer', 'Chuyển tiền giữa các quỹ'],
    ['submit_approval', 'Gửi duyệt phiếu thu / chuyển tiền trên Lark'],
    ['mark_issued', 'Xác nhận đã chi'],
    ['mark_received', 'Xác nhận đã thu'],
    ['close', 'Chốt sổ quỹ hàng ngày'],
    ['cancel', 'Hủy giao dịch quỹ'],
    ['adjust', 'Điều chỉnh sau khi đã chốt sổ'],
  ]),
  ...group('warehouse_cash', [
    ['view', 'Xem tiền mặt kho'],
    ['create', 'Tạo phiếu tiền mặt kho'],
    ['update', 'Sửa phiếu tiền mặt kho'],
    ['post', 'Lập phiếu thu từ tiền mặt kho'],
    ['cancel', 'Hủy phiếu tiền mặt kho'],
  ]),
];

async function main() {
  console.log(`🌱 Upsert ${PERMISSIONS.length} quyền cho luồng thu chi kho...`);
  const removed =
    (await removeBranchSuffixedPermissions(prisma, [
      'warehouse_expense',
      'internal_fund',
    ])) +
    // Quyền của nút "Kho nộp tiền" đã bỏ ở trang Biến động số dư.
    (await removePermissions(prisma, ['internal_fund:create_expense']));
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
    console.error('❌ Lỗi khi thêm quyền thu chi kho:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
