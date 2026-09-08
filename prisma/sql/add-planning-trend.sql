-- Chạy tay khi đồng bộ schema. Agent không được tự chạy migrate/db push.
CREATE TABLE IF NOT EXISTS planning_trend (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NULL REFERENCES products(id),
  category_name VARCHAR(255) NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'UPLIFT',
  uplift_factor DECIMAL(10, 4) NULL,
  extra_quantity DECIMAL(18, 4) NULL,
  note TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS planning_trend_product_id_is_active_idx
  ON planning_trend (product_id, is_active);
CREATE INDEX IF NOT EXISTS planning_trend_start_date_end_date_idx
  ON planning_trend (start_date, end_date);
