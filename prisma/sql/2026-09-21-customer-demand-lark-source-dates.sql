-- Run manually after backing up the target database.
-- Nullable columns preserve existing Demand rows until a confirmed Lark sync
-- restores the source dates from the original records.
ALTER TABLE customer_demand_lines
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMP(3);

ALTER TABLE customer_demand_lark_records
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMP(3);
