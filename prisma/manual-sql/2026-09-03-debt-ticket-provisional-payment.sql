-- Đồng bộ schema cho luồng phiếu ngừng đi hàng và xác nhận chuyển khoản tạm.
-- Chạy thủ công trên database backend. Script idempotent, không xóa dữ liệu.

BEGIN;

ALTER TABLE customer_debt_policies
  ADD COLUMN IF NOT EXISTS require_full_payment_for_invoice BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE debt_tickets
  ADD COLUMN IF NOT EXISTS ticket_type TEXT NOT NULL DEFAULT 'DEBT_COLLECTION';

ALTER TABLE debt_ticket_customers
  ADD COLUMN IF NOT EXISTS required_payment_amount DECIMAL(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE debt_ticket_customers
  ADD COLUMN IF NOT EXISTS provisional_payment_amount DECIMAL(18, 2);

ALTER TABLE debt_ticket_customers
  ADD COLUMN IF NOT EXISTS provisional_sepay_tx_id INTEGER;

CREATE INDEX IF NOT EXISTS debt_ticket_customers_provisional_sepay_tx_id_idx
  ON debt_ticket_customers (provisional_sepay_tx_id);

COMMIT;
