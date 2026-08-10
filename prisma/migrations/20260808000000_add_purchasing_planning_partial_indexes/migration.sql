-- Các partial unique index Prisma schema không biểu diễn được.
-- Chúng bảo vệ job lock và bảo đảm chỉ một snapshot/config active.
CREATE UNIQUE INDEX IF NOT EXISTS uq_calc_run_lock
  ON calculation_run (snapshot_date, run_type)
  WHERE status = 'RUNNING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_reco_active_date
  ON purchase_recommendation (snapshot_date)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_config_active
  ON planning_config (scope_type, COALESCE(scope_id, -1), param_key)
  WHERE is_active = true;
