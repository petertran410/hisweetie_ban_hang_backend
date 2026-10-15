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
// File không tự gán quyền mới cho role/user, trừ một lần khi tách quyền
// Tài chính nội bộ / Approval tuần (chép từ quyền cũ tương ứng) và khi thêm
// quyền xem Đơn Lark Approval (chép từ quyền xem Tài chính nội bộ). Chạy lại
// nhiều lần vẫn an toàn.
//
// Cách chạy:
//   yarn seed:warehouse-finance

import { PrismaClient } from '@prisma/client';
import {
  copyPermissionGrants,
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
  ...group('internal_finance', [['view', 'Xem trang Tài chính nội bộ']]),
  ...group('lark_approval', [
    ['view', 'Xem đơn PHIẾU THU / PHIẾU CHI / PHIẾU CHI KHO tạo trên Lark'],
  ]),
  ...group('weekly_approval', [
    ['view', 'Xem Approval tuần'],
    ['prepare', 'Tổng hợp tuần và hủy batch tuần'],
    ['submit', 'Tạo approval tuần trên Lark'],
  ]),
  ...group('warehouse_expense', [
    ['view', 'Xem phiếu chi kho'],
    ['create', 'Tạo khoản chi khác'],
    ['update', 'Sửa khoản chi khác'],
    ['mark_issued', 'Tick Đã chi và ghi quỹ'],
    ['check_manager', 'Tick kiểm tra cột Quản lý kho'],
    ['check_accountant', 'Tick kiểm tra cột Kế toán kho'],
    ['cancel', 'Hủy phiếu chi kho (kèm lý do)'],
    ['request_review', 'Ghi chú và tag người xem lại phiếu chi (gửi tin Lark)'],
  ]),
  ...group('internal_fund', [
    ['view', 'Xem quỹ nội bộ'],
    ['create_receipt', 'Tạo phiếu thu quỹ'],
    ['transfer', 'Chuyển tiền giữa các quỹ'],
    ['submit_approval', 'Gửi duyệt phiếu thu / chuyển tiền trên Lark'],
    ['mark_issued', 'Xác nhận đã chi'],
    ['mark_received', 'Xác nhận đã thu'],
    ['close', 'Nhập số đối soát chốt sổ quỹ hàng ngày'],
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
    // và hai quyền tick duyệt chốt sổ đã bỏ.
    (await removePermissions(prisma, [
      'internal_fund:create_expense',
      'internal_fund:closing_accountant',
      'internal_fund:closing_chief',
    ]));
  const SPLIT: Array<[from: string, to: string]> = [
    ['cash_flows:view', 'internal_finance:view'],
    ['warehouse_expense:view', 'weekly_approval:view'],
    ['warehouse_expense:prepare', 'weekly_approval:prepare'],
    ['warehouse_expense:submit', 'weekly_approval:submit'],
    ['internal_finance:view', 'lark_approval:view'],
  ];
  // Chỉ chép quyền ở lần quyền mới vừa được tạo; lần chạy sau không gán lại
  // những quyền admin đã chủ động gỡ.
  const existingNew = new Set(
    (
      await prisma.permission.findMany({
        where: { name: { in: SPLIT.map(([, to]) => to) } },
        select: { name: true },
      })
    ).map((row) => row.name),
  );
  const { created, updated } = await upsertFinancePermissions(
    prisma,
    PERMISSIONS,
  );
  // Tách quyền riêng cho Tài chính nội bộ và Approval tuần: ai đang có quyền
  // cũ tương ứng được thêm quyền mới, không ai mất quyền sau khi cập nhật.
  const copied = await copyPermissionGrants(
    prisma,
    SPLIT.filter(([, to]) => !existingNew.has(to)),
  );
  const movedOut = await removePermissions(prisma, [
    'warehouse_expense:prepare',
    'warehouse_expense:submit',
  ]);
  console.log(
    `📊 Tổng kết: tạo mới ${created}, cập nhật ${updated}, xóa quyền kiểu cũ ${removed + movedOut}, chép ${copied} lượt gán sang quyền mới.`,
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
