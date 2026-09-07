-- Đồng bộ policy một loại quy tắc và lịch thanh toán cố định.
-- Chạy thủ công; không xóa dữ liệu hiện có.

ALTER TABLE customer_debt_policies
  ADD COLUMN IF NOT EXISTS debt_rule_type TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE customer_debt_policies
  ADD COLUMN IF NOT EXISTS payment_schedule_type TEXT;

ALTER TABLE customer_debt_policies
  ADD COLUMN IF NOT EXISTS payment_schedule_days JSONB;

-- Giữ hành vi của policy cũ sau khi bổ sung debt_rule_type.
UPDATE customer_debt_policies
SET debt_rule_type = CASE
  WHEN has_credit_limit THEN 'CREDIT_LIMIT'
  WHEN has_term_days THEN 'TERM_DAYS'
  ELSE 'NONE'
END
WHERE debt_rule_type = 'NONE';

CREATE INDEX IF NOT EXISTS customer_debt_policies_debt_rule_type_idx
  ON customer_debt_policies (debt_rule_type);
