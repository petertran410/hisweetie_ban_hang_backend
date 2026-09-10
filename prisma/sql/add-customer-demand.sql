-- Customer Demand (OEM/đặt hộ) — additive schema only.
-- Không chạy tự động. Người dùng tự kiểm tra backup và đồng bộ DB.

CREATE TABLE IF NOT EXISTS customer_demands (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_demands_customer_updated_idx
  ON customer_demands (customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS customer_demand_months (
  id SERIAL PRIMARY KEY,
  demand_id INTEGER NOT NULL REFERENCES customer_demands(id) ON DELETE CASCADE,
  demand_month DATE NOT NULL,
  status VARCHAR(15) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'CONFIRMED', 'CANCELLED')),
  note TEXT,
  approved_at TIMESTAMP(3),
  approved_by INTEGER REFERENCES users(id),
  cancelled_at TIMESTAMP(3),
  cancelled_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (demand_id, demand_month)
);

CREATE INDEX IF NOT EXISTS customer_demand_months_month_status_idx
  ON customer_demand_months (demand_month, status);

CREATE TABLE IF NOT EXISTS customer_demand_lines (
  id SERIAL PRIMARY KEY,
  demand_month_id INTEGER NOT NULL REFERENCES customer_demand_months(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  input_quantity NUMERIC(18, 4) NOT NULL CHECK (input_quantity > 0),
  input_unit VARCHAR(10) NOT NULL DEFAULT 'BASE'
    CHECK (input_unit IN ('BASE', 'CARTON')),
  quantity_base NUMERIC(18, 4) NOT NULL CHECK (quantity_base > 0),
  conversion_value NUMERIC(18, 4) NOT NULL CHECK (conversion_value > 0),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (demand_month_id, product_id)
);

CREATE INDEX IF NOT EXISTS customer_demand_lines_product_month_idx
  ON customer_demand_lines (product_id, demand_month_id);

CREATE TABLE IF NOT EXISTS customer_demand_change_logs (
  id SERIAL PRIMARY KEY,
  demand_month_id INTEGER NOT NULL REFERENCES customer_demand_months(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_demand_change_logs_month_created_idx
  ON customer_demand_change_logs (demand_month_id, created_at DESC);
