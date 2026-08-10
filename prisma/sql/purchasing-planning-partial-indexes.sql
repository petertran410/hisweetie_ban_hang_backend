-- Partial unique index cho Purchasing Planning.
--
-- Prisma schema KHÔNG biểu diễn được partial index (index có điều kiện WHERE),
-- nên `prisma db push` sẽ không tạo 3 index dưới đây. Phải chạy tay MỘT LẦN
-- trên mỗi database (production, sandbox, local) sau khi schema đã được push.
--
-- Vai trò:
--   uq_calc_run_lock         — job lock: chặn 2 lần tính toán cùng chạy trên
--                              cùng (snapshot_date, run_type).
--   uq_reco_active_date      — chỉ cho phép 1 bộ đề xuất ACTIVE mỗi ngày.
--   uq_planning_config_active — chỉ cho phép 1 config active mỗi
--                              (scope_type, scope_id, param_key).
--
-- Cách chạy:
--   psql "$DATABASE_URL" -f prisma/sql/purchasing-planning-partial-indexes.sql
--
-- Cả 3 lệnh đều IF NOT EXISTS nên chạy lại nhiều lần không gây lỗi.

CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_run_lock
  ON calculation_run (snapshot_date, run_type)
  WHERE status = 'RUNNING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_reco_active_date
  ON purchase_recommendation (snapshot_date)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_config_active
  ON planning_config (scope_type, COALESCE(scope_id, -1), param_key)
  WHERE is_active = true;
