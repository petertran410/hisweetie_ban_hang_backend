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
  (
    'warehouse_cash:view',
    'warehouse_cash',
    'view',
    'Xem trang và chứng từ tiền mặt kho',
    'Tài chính',
    'all',
    NOW(),
    NOW()
  ),
  (
    'warehouse_cash:create',
    'warehouse_cash',
    'create',
    'Tạo phiếu tiền mặt kho',
    'Tài chính',
    'all',
    NOW(),
    NOW()
  ),
  (
    'warehouse_cash:update',
    'warehouse_cash',
    'update',
    'Sửa phiếu tiền mặt kho đang mở',
    'Tài chính',
    'all',
    NOW(),
    NOW()
  ),
  (
    'warehouse_cash:post',
    'warehouse_cash',
    'post',
    'Lập phiếu thu và phân bổ tiền mặt kho',
    'Tài chính',
    'all',
    NOW(),
    NOW()
  ),
  (
    'warehouse_cash:cancel',
    'warehouse_cash',
    'cancel',
    'Hủy phiếu tiền mặt kho',
    'Tài chính',
    'all',
    NOW(),
    NOW()
  )
ON CONFLICT ("name") DO UPDATE
SET
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "scope" = EXCLUDED."scope",
  "updatedAt" = NOW();

COMMIT;
