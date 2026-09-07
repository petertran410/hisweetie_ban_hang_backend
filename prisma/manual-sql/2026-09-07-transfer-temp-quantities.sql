CREATE TABLE IF NOT EXISTS "transfer_temp_quantities" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "from_branch_id" INTEGER NOT NULL,
  "to_branch_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0 CHECK ("quantity" >= 0),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transfer_temp_quantities_user_id_product_id_from_branch_id_to_branch_id_key"
    UNIQUE ("user_id", "product_id", "from_branch_id", "to_branch_id")
);

CREATE INDEX IF NOT EXISTS "transfer_temp_quantities_user_id_from_branch_id_to_branch_id_quantity_idx"
  ON "transfer_temp_quantities" ("user_id", "from_branch_id", "to_branch_id", "quantity");
