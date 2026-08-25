-- ═══════════════════════════════════════════════════════════════════════════
-- Bổ sung cột kết quả "khi nào phải đặt hàng" vào recommendation_item
--
-- Vì sao cần: engine giờ trả lời được câu hỏi trung tâm của màn hình dự kiến
-- đặt hàng — tháng này hay tháng sau mới phải đặt, chi nhánh nào thiếu trước,
-- doanh số SKU đó có ổn định không. Các kết quả này cần chỗ lưu.
--
-- An toàn:
--   • Chỉ ADD COLUMN, tất cả đều NULL-able → không đụng dữ liệu đang có.
--   • Không xoá, không đổi kiểu, không set NOT NULL.
--   • Các dòng đề xuất cũ sẽ có giá trị NULL ở 7 cột này; chạy lại tính toán
--     là có dữ liệu mới.
--
-- Chạy:
--   psql "$DATABASE_URL" -f prisma/manual-sql/2026-08-24-recommendation-order-timing.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "recommendation_item"
  -- ORDER_NOW | ORDER_THIS_MONTH | ORDER_NEXT_MONTH | ORDER_LATER | NO_ACTION
  ADD COLUMN IF NOT EXISTS "order_urgency"         VARCHAR(20),
  -- Ngày chậm nhất phải đặt để hàng kịp về trước khi chi nhánh cạn kho
  ADD COLUMN IF NOT EXISTS "latest_order_date"     DATE,
  -- Chi nhánh sẽ hết hàng sớm nhất — nơi tạo sức ép phải đặt
  ADD COLUMN IF NOT EXISTS "critical_branch_id"    INTEGER,
  ADD COLUMN IF NOT EXISTS "critical_branch_name"  VARCHAR(255),
  -- STABLE | VOLATILE | INSUFFICIENT_DATA
  ADD COLUMN IF NOT EXISTS "demand_stability"      VARCHAR(20),
  -- Hệ số biến thiên doanh số theo tháng; cơ sở tính tồn dự phòng
  ADD COLUMN IF NOT EXISTS "variation_coefficient" DECIMAL(10,4),
  -- Cận dưới của tổng leadtime 4 giai đoạn (cận trên nằm ở lead_time_days)
  ADD COLUMN IF NOT EXISTS "lead_time_min_days"    SMALLINT;
