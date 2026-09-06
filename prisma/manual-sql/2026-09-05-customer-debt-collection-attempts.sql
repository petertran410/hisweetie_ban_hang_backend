-- Manual only. Do not execute automatically.
-- Lịch sử các lần kế toán/sale thực tế đòi công nợ.

CREATE TABLE IF NOT EXISTS "customer_debt_collection_attempts" (
  "id" SERIAL NOT NULL,
  "customer_id" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "attempt_date" DATE NOT NULL,
  "recorded_by_id" INTEGER NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersedes_id" INTEGER,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "action_type" TEXT NOT NULL DEFAULT 'CREATE',
  "reason" TEXT,
  CONSTRAINT "customer_debt_collection_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_debt_collection_attempts_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_debt_collection_attempts_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "customer_debt_collection_attempts_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "customer_debt_collection_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "customer_debt_collection_attempts_customer_id_role_attempt_date_idx"
  ON "customer_debt_collection_attempts" ("customer_id", "role", "attempt_date");
CREATE INDEX IF NOT EXISTS "customer_debt_collection_attempts_customer_id_role_is_active_idx"
  ON "customer_debt_collection_attempts" ("customer_id", "role", "is_active");
CREATE INDEX IF NOT EXISTS "customer_debt_collection_attempts_recorded_by_id_recorded_at_idx"
  ON "customer_debt_collection_attempts" ("recorded_by_id", "recorded_at");
