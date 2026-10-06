BEGIN;

INSERT INTO permissions (
  "name",
  "resource",
  "action",
  "description",
  "category",
  "scope",
  "createdAt",
  "updatedAt"
)
VALUES
  ('internal_fund:view_hn', 'internal_fund', 'view_hn', 'Xem quỹ nội bộ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:view_sg', 'internal_fund', 'view_sg', 'Xem quỹ nội bộ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:view_vp', 'internal_fund', 'view_vp', 'Xem quỹ nội bộ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_receipt_hn', 'internal_fund', 'create_receipt_hn', 'Tạo phiếu thu nội bộ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_receipt_sg', 'internal_fund', 'create_receipt_sg', 'Tạo phiếu thu nội bộ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_receipt_vp', 'internal_fund', 'create_receipt_vp', 'Tạo phiếu thu nội bộ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_expense_hn', 'internal_fund', 'create_expense_hn', 'Tạo phiếu chi nội bộ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_expense_sg', 'internal_fund', 'create_expense_sg', 'Tạo phiếu chi nội bộ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:create_expense_vp', 'internal_fund', 'create_expense_vp', 'Tạo phiếu chi nội bộ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:transfer_hn', 'internal_fund', 'transfer_hn', 'Chuyển tiền từ/đến Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:transfer_sg', 'internal_fund', 'transfer_sg', 'Chuyển tiền từ/đến Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:transfer_vp', 'internal_fund', 'transfer_vp', 'Chuyển tiền từ/đến Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:submit_approval_hn', 'internal_fund', 'submit_approval_hn', 'Gửi Approval quỹ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:submit_approval_sg', 'internal_fund', 'submit_approval_sg', 'Gửi Approval quỹ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:submit_approval_vp', 'internal_fund', 'submit_approval_vp', 'Gửi Approval quỹ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_issued_hn', 'internal_fund', 'mark_issued_hn', 'Xác nhận đã chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_issued_sg', 'internal_fund', 'mark_issued_sg', 'Xác nhận đã chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_issued_vp', 'internal_fund', 'mark_issued_vp', 'Xác nhận đã chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_received_hn', 'internal_fund', 'mark_received_hn', 'Xác nhận đã thu Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_received_sg', 'internal_fund', 'mark_received_sg', 'Xác nhận đã thu Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:mark_received_vp', 'internal_fund', 'mark_received_vp', 'Xác nhận đã thu Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:close_hn', 'internal_fund', 'close_hn', 'Chốt sổ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:close_sg', 'internal_fund', 'close_sg', 'Chốt sổ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:close_vp', 'internal_fund', 'close_vp', 'Chốt sổ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:cancel_hn', 'internal_fund', 'cancel_hn', 'Hủy giao dịch quỹ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:cancel_sg', 'internal_fund', 'cancel_sg', 'Hủy giao dịch quỹ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:cancel_vp', 'internal_fund', 'cancel_vp', 'Hủy giao dịch quỹ Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:adjust_hn', 'internal_fund', 'adjust_hn', 'Điều chỉnh chốt sổ Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:adjust_sg', 'internal_fund', 'adjust_sg', 'Điều chỉnh chốt sổ Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('internal_fund:adjust_vp', 'internal_fund', 'adjust_vp', 'Điều chỉnh chốt sổ Văn phòng', 'Tài chính', 'all', NOW(), NOW())
ON CONFLICT ("name") DO UPDATE
SET
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "scope" = EXCLUDED."scope",
  "updatedAt" = NOW();

COMMIT;
