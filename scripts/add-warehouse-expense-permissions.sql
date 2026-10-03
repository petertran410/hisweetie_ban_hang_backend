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
  ('warehouse_expense:view_hn', 'warehouse_expense', 'view_hn', 'Xem phiếu chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:view_sg', 'warehouse_expense', 'view_sg', 'Xem phiếu chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:view_vp', 'warehouse_expense', 'view_vp', 'Xem phiếu chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:create_hn', 'warehouse_expense', 'create_hn', 'Tạo khoản chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:create_sg', 'warehouse_expense', 'create_sg', 'Tạo khoản chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:create_vp', 'warehouse_expense', 'create_vp', 'Tạo khoản chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:update_hn', 'warehouse_expense', 'update_hn', 'Sửa khoản chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:update_sg', 'warehouse_expense', 'update_sg', 'Sửa khoản chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:update_vp', 'warehouse_expense', 'update_vp', 'Sửa khoản chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:prepare_hn', 'warehouse_expense', 'prepare_hn', 'Tổng hợp phiếu chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:prepare_sg', 'warehouse_expense', 'prepare_sg', 'Tổng hợp phiếu chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:prepare_vp', 'warehouse_expense', 'prepare_vp', 'Tổng hợp phiếu chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:submit_hn', 'warehouse_expense', 'submit_hn', 'Gửi Approval phiếu chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:submit_sg', 'warehouse_expense', 'submit_sg', 'Gửi Approval phiếu chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:submit_vp', 'warehouse_expense', 'submit_vp', 'Gửi Approval phiếu chi Văn phòng', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:mark_issued_hn', 'warehouse_expense', 'mark_issued_hn', 'Xác nhận Đã chi Kho Hà Nội', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:mark_issued_sg', 'warehouse_expense', 'mark_issued_sg', 'Xác nhận Đã chi Kho Sài Gòn', 'Tài chính', 'all', NOW(), NOW()),
  ('warehouse_expense:mark_issued_vp', 'warehouse_expense', 'mark_issued_vp', 'Xác nhận Đã chi Văn phòng', 'Tài chính', 'all', NOW(), NOW())
ON CONFLICT ("name") DO UPDATE
SET
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "scope" = EXCLUDED."scope",
  "updatedAt" = NOW();

COMMIT;
