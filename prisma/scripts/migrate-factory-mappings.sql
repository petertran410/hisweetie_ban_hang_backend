-- Chuyển sang mô hình nhà máy nhiều-nhiều (factory_products là nguồn duy nhất)
-- và log dạng event-per-mapping.
--
-- CHẠY THEO ĐÚNG THỨ TỰ. Bước 1-2 phải chạy TRƯỚC khi drop cột ở bước 3,
-- nếu không dữ liệu trong 2 cột cũ sẽ mất vĩnh viễn.
--
-- Khuyến nghị: backup DB trước khi chạy.
--   pg_dump -Fc -f backup-truoc-khi-doi-nha-may.dump <database>

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Backfill mapping từ 2 cột cũ.
--    Chỉ thêm dòng còn thiếu; mapping đã có luôn thắng vì có thể đang giữ
--    giá / MOQ / leadtime.
-- ---------------------------------------------------------------------------
INSERT INTO factory_products
  ("factoryId", "productId", role, priority, currency, "isActive", "createdAt", "updatedAt")
SELECT p."primaryFactoryId", p.id, 'primary', 0, 'VND', true, NOW(), NOW()
FROM products p
WHERE p."primaryFactoryId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM factory_products fp
    WHERE fp."productId" = p.id AND fp."factoryId" = p."primaryFactoryId"
  );

INSERT INTO factory_products
  ("factoryId", "productId", role, priority, currency, "isActive", "createdAt", "updatedAt")
SELECT p."backupFactoryId", p.id, 'backup', 0, 'VND', true, NOW(), NOW()
FROM products p
WHERE p."backupFactoryId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM factory_products fp
    WHERE fp."productId" = p.id AND fp."factoryId" = p."backupFactoryId"
  );

-- ---------------------------------------------------------------------------
-- 2. Mở rộng bảng log sang dạng event-per-mapping.
--    Cột mới nullable → dòng log cũ vẫn đọc được, không cần xoá.
-- ---------------------------------------------------------------------------
ALTER TABLE factory_change_logs
  ADD COLUMN IF NOT EXISTS action             TEXT NOT NULL DEFAULT 'attach',
  ADD COLUMN IF NOT EXISTS "previousRole"     TEXT,
  ADD COLUMN IF NOT EXISTS "previousPriority" INTEGER,
  ADD COLUMN IF NOT EXISTS priority           INTEGER;

-- `role` cũ NOT NULL; mô hình mới cho phép NULL khi detach.
ALTER TABLE factory_change_logs ALTER COLUMN role DROP NOT NULL;

-- Suy ra `action` cho dữ liệu lịch sử từ `reason` của mô hình slot cũ.
UPDATE factory_change_logs
SET action = CASE
  WHEN reason = 'unlink' THEN 'detach'
  WHEN reason = 'swap'   THEN 'role_change'
  ELSE 'attach'
END
WHERE action = 'attach' AND reason IS NOT NULL;

-- Dòng cũ ghi factoryId = 0 khi unlink (FK giả). Không xoá để giữ dấu vết,
-- chỉ đánh dấu để báo cáo bỏ qua.
UPDATE factory_change_logs
SET action = 'detach', reason = COALESCE(reason, '') || ' [legacy-unlink]'
WHERE "factoryId" = 0;

CREATE INDEX IF NOT EXISTS "factory_change_logs_productId_createdAt_idx"
  ON factory_change_logs ("productId", "createdAt");

-- ---------------------------------------------------------------------------
-- 3. Bỏ 2 cột cũ trên products.
--    CHỈ chạy sau khi bước 1 đã xong và đã kiểm tra dữ liệu.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "products_primaryFactoryId_idx";
DROP INDEX IF EXISTS "products_backupFactoryId_idx";

ALTER TABLE products
  DROP COLUMN IF EXISTS "primaryFactoryId",
  DROP COLUMN IF EXISTS "backupFactoryId";

COMMIT;

-- ---------------------------------------------------------------------------
-- Kiểm tra sau khi chạy (nên chạy trước COMMIT nếu muốn soát kỹ):
--
--   -- Không sản phẩm nào mất nhà máy:
--   SELECT COUNT(*) FROM factory_products;
--
--   -- Sản phẩm có nhiều hơn 1 nhà máy chính (điều mà mô hình cũ không làm được):
--   SELECT "productId", COUNT(*) FROM factory_products
--   WHERE role = 'primary' AND "isActive" GROUP BY "productId" HAVING COUNT(*) > 1;
-- ---------------------------------------------------------------------------
